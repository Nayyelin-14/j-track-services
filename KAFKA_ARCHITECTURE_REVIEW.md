# J-Track Kafka Architecture — Critical Review

> A senior backend architect review of the Kafka implementation in J-Track, a job-marketplace backend built as a TypeScript/Express microservices monorepo.

## 1. Portfolio Evaluation — Score: 7/10

This is **already well above average** for a junior/mid portfolio. Most juniors do "Kafka: I send messages and a consumer logs them." J-Track has:

- 3 real topics with distinct producers/consumers
- Genuine **fan-out** via separate consumer groups (analytics + notification both consuming `job-events` independently)
- **Typed events** (`JobEvent` discriminated union)
- Mail consumer with **retry + DLQ**
- Shared producer registry, connection backoff, topic lifecycle, health checks, graceful shutdown

That is a coherent event-driven story, not checklist noise. **Why not higher:** the three things an interviewer will probe are exactly the three gaps you already sensed — fire-and-forget publishing, no outbox, and two consumers that drop-on-fail. Fix those and you're at 8.5–9 honestly, _without adding a single new topic_.

## 2. Real Kafka Use Cases vs. Over-Engineering

**Genuinely justified:**

- **Mail sending** — correct Kafka case. The request path shouldn't block on SMTP; delivery is retryable/tolerant; async is the natural fit.
- **`job.viewed` analytics** — this is the _most_ Kafka-appropriate event. High-frequency, low-value, non-blocking, safe to lose occasionally. Perfect example of "events where eventual consistency is fine."
- **`job.applied` fan-out** — two independent consumers (analytics increment + recruiter email) genuinely need it. This is real pub/sub.
- **`application.status_changed`** — same fan-out to email + analytics.

**Could be HTTP instead:**

- Almost nothing, honestly. The notification consumer _could_ be a direct HTTP call from Job → Utils, but keeping it on the same `job-events` stream is defensible and more elegant, since you already have the fan-out for analytics.

**The actual over-engineering risk isn't in what's built — it's the temptation to add topics like `user-events`, `audit-log`, `recommendation-queue` etc.** None of those serve a second consumer.

## 3. Depth > Quantity — The 4 Highest-Value Improvements

These are the only ones worth implementing:

1. **Transactional Outbox** on Job + Auth — fixes the reliability gap, single highest-value item. This is THE pattern interviewers ask about.
2. **Event IDs + idempotent consumers** — dedup at the consumer. Pairs with the outbox for "at-least-once."
3. **Unify failure handling: DLQ for analytics + notification**, via a shared retry/DLQ helper in the shared Kafka package.
4. **Partition keys** on publish (`job_id`) for ordering semantics.

Everything else is evaluated in sections 4–8, and most of it should be skipped.

## 4. Production Improvement Evaluation

| Pattern                     | Implement?              | Why                                                                                      | Difficulty  | Portfolio value              | Overkill?         |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- | ----------- | ---------------------------- | ----------------- |
| **Transactional Outbox**    | ✅ Yes                  | Top gap; DB-write→publish reliability                                                    | Medium      | Very high                    | No                |
| **Idempotent consumers**    | ✅ Yes                  | Cheap, high-value, enables safe retries                                                  | Medium      | High                         | No                |
| **Retry topics**            | 🟡 Lighter version      | Shared retry-then-DLQ helper; full retry-topics infra is overkill                        | Medium–Hard | Medium                       | Partial           |
| **DLQ for all consumers**   | ✅ Yes                  | Unify the 3 consumers' failure paths into one shared pattern                             | Easy–Medium | High                         | No                |
| **Exponential backoff**     | ✅ Already partly there | Already present on connect; extend to consumer retries                                   | Easy        | —                            | No                |
| **Partition keys**          | ✅ Yes                  | Correct ordering story                                                                   | Easy        | High                         | No                |
| **Consumer lag monitoring** | 🟡 Lite                 | `/health` or admin endpoint exposing per-group offsets, not a Grafana dashboard          | Easy        | Medium                       | Skip full version |
| **Event replay**            | ❌ Skip                 | Only meaningful with schema/registry and durable events                                  | Hard        | Low                          | Yes               |
| **Schema/versioning**       | 🟡 Lite                 | Add a `version` field + keep typed unions; _not_ a Schema Registry                       | Easy        | Medium                       | Yes (registry)    |
| **Kafka transactions**      | ❌ Skip                 | High complexity, big failure surface, near-zero visible payoff                           | Hard        | Low                          | Yes               |
| **Exactly-once**            | ❌ Skip                 | Cannot credibly demonstrate EOS in a portfolio; production reality is "effectively once" | Hard        | Low–med (talking point only) | Yes               |

**The one thing that must never happen:** putting "exactly-once processing" or "Kafka transactions" on the resume. Every senior interviewer knows a single-node local Kafka + Express monorepo does not do true EOS.

## 5. Partition Design

**3 partitions / RF 1:** Fine for local dev and a portfolio. In production RF would be 3; for Docker/local deployment, RF 1 with 3 partitions is appropriate. Say that in the interview — it shows you know the difference.

**Partition keys — the key insight:**

- Kafka orders **within a partition only**. Same key → same partition → order preserved.
- `job.viewed` / `job.applied` / `application.status_changed` feed **counter increments**. Counters are commutative — `views+1, applies+1` produces the same total regardless of order. So today order genuinely doesn't matter for analytics.
- **BUT** the moment state matters (e.g. "latest application status", "viewed before applied" funnels), ordering matters. Publish with **`key: job_id`** so all events for a job land in one partition in produce-order. That's the correct key here.
- Use `application_id` as the key **only** if you need per-application state transitions ordered individually.

Interview talking point: _"I keyed by `job_id` so per-job event ordering is preserved within a partition, and I documented that the analytics increments are commutative so ordering isn't even required for correctness of the counters."_

## 6. Reliability: DB write → Kafka publish

**Failure scenarios:**

1. DB commits, publish fails (Kafka down / producer not connected) → **event lost**. The silent, common one.
2. DB fails → nothing published → consistent, fine.
3. Publish fails _after_ broker accepts (non-idempotent producer, broker crash before ack) → lost.
4. Process crashes between DB commit and publish → lost.
5. Client retries → duplicate event (`@@unique([job_id, applicant_id])` protects applies, but duplicate views still inflate counts).

**What the outbox does:** write the event **in the same DB transaction** as the business write, then a relay publishes to Kafka. Result: at-least-once arrival, transactional consistency, no lost events from in-process failures.

**Improved architecture:**

```
Job/User/Auth service
   │  business INSERT/UPDATE (prisma.$transaction)
   ▼
┌─────────────────────────────┐
│  jobs / users ...           │
│  outbox(id, aggregate_id,   │  ← same transaction
│         event_type, payload,│
│         status, created_at) │
└──────────────┬──────────────┘
               │ inspectOutbox poller:
               │ FOR UPDATE SKIP LOCKED, LIMIT n
               ▼
            Kafka (key = aggregate_id)
               │
   ┌───────────┼───────────┐
   ▼           ▼           ▼
 Analytics   Notification  Mail
```

Implementation choices:

- **Poller (`SKIP LOCKED`)** — appropriate for this project. Run it in the service on an interval; publish rows marked `pending`, then mark `published`.
- **Debezium / logical decoding** — the "industry" answer, but hard to demo in a portfolio and overkill here. Talk about it as "the path you'd take at scale," then explain you chose the poller deliberately for simplicity.
- **Postgres NOTIFY/LISTEN** + fallback poller is a nice middle ground to reduce latency.

## 7. Fire-and-Forget Publishing

Honestly? For a demo/README context, acceptable. For a **production posture**, no.

What can go wrong:

- `publish()` **throws if the producer isn't connected** (`producer.ts:61-63`). `.catch(console.error)` then swallows it → silent loss.
- No retry, no acknowledgment handling, no dedup key → duplicates under retries.
- No visibility: you cannot tell a message was lost except by a log line.

**Production-oriented minimum:**

1. **Move the write-path publishes into the outbox** (section 6) — the request handler stops publishing directly. This alone removes the failure mode.
2. For anything published directly: `await`, verify `isConnected()`, retry with backoff.
3. Use KafkaJS's default `acks: all` + **idempotent producer mode** (enabled by default) with consumer-side dedup for at-least-once / effectively-once.

## 8. Consumer Failure Handling — Redesign

Unify the three consumers onto **one shared failure contract** in `@jtrack/shared`:

```
each message →
  1. parse/validate      → fail = poison pill → DLQ (never retry)
  2. idempotency check    → already processed (by event id) → skip
  3. process              → transient failure → retry with backoff (N times)
  4. retries exhausted    → DLQ with error reason + timestamp
```

- **Mail consumer** already approximates this — formalize it with a dedup step and structured DLQ reason.
- **Analytics consumer** (currently log + drop): the fix is easy because the **upsert is already naturally idempotent** — `increment` is safe to re-apply. The real fix is "don't drop," and the upsert already dedups.
- **Notification consumer** (currently log + drop): naive retries would **resend duplicate emails** — so **consumer-side dedup is mandatory** (store a `sent_events` set / dedup table keyed by event id before sending).

Don't build the full "retry topics with scheduled delay" topology. A shared `retry-with-backoff-then-DLQ` helper gives 90% of the production story with 20% of the complexity, and it's one consistent pattern across three consumers.

## 9. Ideal J-Track Kafka Architecture (realistic)

```
Auth Service      Job Service
   │ outbox           │ outbox            (same DB txn as business write)
   ▼                  ▼
 relay (poller, SKIP LOCKED, key = aggregate_id)
   │                  │
   ▼                  ▼
 send-mail          job-events (key=job_id, 3 partitions)
   │                  ├── job-analytics-group → Analytics
   │                  │       (idempotent counters, retry→DLQ)
   │                  └── notification-group → Notification
   │                          (event-id dedup → email → retry→DLQ)
   ▼
 mail-service-group → Mail (validate, dedup, retry→DLQ)
   │
   ▼
 send-mail-dlq  ← shared DLQ path for all three consumers
```

**Each component and its purpose:**

1. **Outbox tables** (per service with a DB) — write business state + event in one txn; guarantees at-least-once.
2. **Relay** — the poller publishing with correct partition keys; decouples "what happened" from "when it's delivered."
3. **`send-mail`** — async, retryable email; request path never touches SMTP.
4. **`job-events`** — the source-of-truth stream; _two independent groups_ consume it = the fan-out demo.
5. **Analytics** — idempotent by construction (counter increments), retry→DLQ only for DB bursts.
6. **Notification** — dedup keyed on event id (prevents double-emails), retry→DLQ.
7. **DLQ topics** — one shared pattern: poison pills + exhausted retries land here with reason/timestamp.

That's it. **Three topics, three consumers, one reliability pattern, one outbox.** Smaller than "add lots of topics," and it demonstrates every concept worth having.

## 10. Implementation Roadmap

### Phase 1 — Must Have

1. **Outbox on Job + Auth** — `prisma.$transaction`, `outbox` table, poller (`SKIP LOCKED`) — **Medium**
2. **Event IDs + idempotent consumers** (mail dedup table, notification dedup) — **Medium**
3. **DLQ + retry for analytics & notification** via a shared helper — **Easy–Medium**
4. **Partition keys** (`job_id`) on all `job-events` publishes — **Easy**

### Phase 2 — Strong Portfolio

5. **Shared consumer failure pipeline** (parse→dedup→retry→DLQ) extracted into `@jtrack/shared` so all 3 consumers use one helper — **Medium**
6. **Consumer lag exposure** — admin `describeGroup`/`fetchOffsets` in the health endpoint — **Easy–Medium**
7. **Message `version` field + changelog** in event payloads — **Easy**
8. **Observability** — correlation/structured logging of publish + consume with event ids — **Easy**

### Phase 3 — Optional (talking points only)

9. **Retry topic with delayed delivery** if you want to demo the real Kafka retry topology — **Hard-ish, Medium value**
10. Replace poller with **Postgres NOTIFY/LISTEN + fallback polling** to reduce outbox latency — **Medium**
11. **Debezium CDC** — impressive but genuinely overkill; only talk about it — **Hard**

Skip: Kafka transactions, Schema Registry, EOS, event replay tooling.

## 11. Resume / Portfolio Descriptions (accurate, no inflation)

### One-line resume bullet

> Built an event-driven job marketplace on Kafka with 3 topics, transactional outbox for reliable delivery, 3 independent consumer groups with idempotent processing, retries, and DLQ, powering analytics aggregation and async email.

### GitHub README description

> **Kafka event architecture.** J-Track uses Apache Kafka for all cross-service async communication. Auth and Job services write business state + events atomically via a transactional outbox, and a polled relay publishes to `job-events` and `send-mail` with partition keys that preserve per-entity ordering. Three consumer groups process the stream independently: an **analytics consumer** upserts daily counter increments into `job_analytics` (idempotent by construction), a **notification consumer** sends recruiters real-time alerts (deduplicated by event ID), and a **mail consumer** delivers transactional email with retry + DLQ. A shared consumer helper enforces a uniform parse → dedup → retry → DLQ pipeline, and every consumer reports health + lag via the service health endpoint.

### Technical interview explanation

> "My Kafka usage serves three real needs: analytics aggregation, recruiter notifications, and async email. Job and Auth services never publish directly from the request path — I write the event into an outbox in the same transaction as the business write, and a poller using `FOR UPDATE SKIP LOCKED` publishes to Kafka with at-least-once semantics and keying by `job_id` for per-job ordering. Analytics and notification use separate consumer groups on the same `job-events` topic, which is the fan-out. Consumers are idempotent: analytics relies on commutative counter increments, notification dedups by event ID so retries can't double-send emails, and mail goes through retry-then-DLQ. I deliberately chose the polling outbox over Debezium for simplicity, and I skip Kafka transactions because I'd rather have honest at-least-once + idempotent consumers than claim exactly-once I can't really guarantee."

---

## Bottom line

The current implementation is a **legit 7/10** and already better than ~90% of junior portfolios — the _presence_ of fan-out, typed events, retry+DLQ, and health checks is real engineering, not decoration. The four improvements above (outbox, idempotency, unified DLQ, partition keys) push it to an honest 9/10 **without growing the surface area**, and each is a classic interview topic you can explain with real reasoning.

Here's my full review. I'll be direct throughout — including where your concern is unfounded.

1. Portfolio Evaluation — Score: 7/10
   This is already well above average for a junior/mid portfolio. Most juniors do "Kafka: I send messages and a consumer logs them." You have:

- 3 real topics with distinct producers/consumers
- Genuine fan-out via separate consumer groups (analytics + notification both consuming job-events independently)
- Typed events (JobEvent discriminated union)
- Mail consumer with retry + DLQ
- Shared producer registry, connection backoff, topic lifecycle, health checks, graceful shutdown
  That is a coherent event-driven story, not checklist noise. Why not higher: the three things an interviewer will probe are exactly the three gaps you already sensed — fire-and-forget publishing, no outbox, and two consumers that drop-on-fail. Fix those and you're at 8.5–9 honestly, without adding a single new topic.

2. Real Kafka Use Cases vs. Over-Engineering
   Genuinely justified:

- Mail sending — correct Kafka case. The request path shouldn't block on SMTP; delivery is retryable/tolerant; async is the natural fit.
- job.viewed analytics — this is the most Kafka-appropriate event. High-frequency, low-value, non-blocking, safe to lose occasionally. Perfect example of "events where eventual consistency is fine."
- job.applied fan-out — two independent consumers (analytics increment + recruiter email) genuinely need it. This is real pub/sub.
- application.status_changed — same fan-out to email + analytics.
  Could be HTTP instead:
- Almost nothing, honestly. The notification consumer could be a direct HTTP call from Job → Utils, but keeping it on the same job-events stream is defensible and more elegant, since you already have the fan-out for analytics.
  The actual over-engineering risk isn't in what you built — it's the temptation I'll reject in section 3. Don't add topics like user-events, audit-log, recommendation-queue etc. None serve a second consumer.

3. Depth > Quantity — The 4 Highest-Value Improvements
   These are the only ones I'd actually implement (details in sections 4–8):
1. Transactional Outbox on Job + Auth — fixes the reliability gap, single highest-value item. This is THE pattern interviewers ask about.
1. Event IDs + idempotent consumers — dedup at the consumer. Pairs with the outbox for "at-least-once."
1. Unify failure handling: DLQ for analytics + notification, via a shared retry/DLQ helper in the shared Kafka package.
1. Partition keys on publish (job_id) for ordering semantics.
   Everything else I evaluate below — and I'll tell you to skip most of it.
1. Production Improvement Evaluation (honest)
   Pattern Implement? Why Difficulty Portfolio value
   Transactional Outbox ✅ Yes Your #1 gap; the DB-write→publish gap is real Medium Very high
   Idempotent consumers ✅ Yes Cheap, high-value, enables safe retries Medium High
   Retry topics 🟡 Lighter version Do a shared retry-then-DLQ helper; full retry-topic-with-delay infrastructure is overkill Medium–Hard Medium
   DLQ for all consumers ✅ Yes Unify the 3 consumers' failure paths into one shared pattern Easy–Medium High
   Exponential backoff ✅ Already partly there You have it on connect; extend to consumer retries Easy —
   Partition keys ✅ Yes Correct ordering story Easy High
   Consumer lag monitoring 🟡 Lite A /health or admin endpoint exposing per-group offsets — not a full Grafana dashboard Easy Medium
   Event replay ❌ Skip Only meaningful with a schema/registry and durable events; niche for a portfolio Hard Low
   Schema/versioning 🟡 Lite Add a version field + keep typed unions; not a Schema Registry Easy Medium
   Kafka transactions ❌ Skip High complexity, big failure surface, near-zero visible payoff in a small app Hard Low
   Exactly-once ❌ Skip You cannot credibly demonstrate EOS in a portfolio anyway; never claim it — production reality is "effectively once" via idempotent consumers + dedup Hard Low-med (talking point only)
   The one thing you must never do: put "exactly-once processing" or "Kafka transactions" on your resume. Every senior interviewer knows a single-node local Kafka + Express monorepo does not do true EOS, and it's an instant credibility hit.
1. Partition Design
   3 partitions / RF 1: Fine for local dev and a portfolio. In production RF would be 3; for your Docker/local deployment, RF 1 with 3 partitions is appropriate and honest. Say exactly that in the interview — it shows you know the difference.
   Partition keys — the key insight:

- Kafka orders within a partition only. Same key → same partition → order preserved.
- Your job.viewed/job.applied/application.status_changed events feed counter increments. Counters are commutative — views+1, applies+1 produces the same total regardless of order. So today, order genuinely doesn't matter for analytics, and per-job ordering is not broken by round-robin.
- BUT the moment you want state (e.g. "latest application status", "viewed before applied" funnels), ordering matters. Publish with key: job_id so all events for a job land in one partition in produce-order. That's the correct key here.
- Use application_id as the key only if you need per-application state transitions (Applied→Submitted→Hired) ordered individually. For your current events, job_id is right.
  This is an excellent interview talking point: "I keyed by job_id so per-job event ordering is preserved within a partition, and I documented that the analytics increments are commutative so ordering isn't even required for correctness of the counters."

6. Reliability: DB write → Kafka publish
   Failure scenarios:
1. DB commits, publish fails (Kafka down / producer not connected) → event lost. The silent, common one.
1. DB fails → nothing published → consistent, fine.
1. Publish fails after broker accepts (non-idempotent producer, broker crash before ack) → lost.
1. Process crashes between DB commit and publish → lost.
1. Client retries → duplicate event (your @@unique([job_id, applicant_id]) protects duplicates for applies, but duplicate views still inflate counts).
   What the outbox does: write the event in the same DB transaction as the business write, then a relay publishes to Kafka. Result: at-least-once arrival, transactional consistency, no lost events from in-process failures.
   Improved architecture:
   Job/User/Auth service
   │ business INSERT/UPDATE (prisma.$transaction)
   ▼
   ┌─────────────────────────────┐
   │ jobs / users ... │
   │ outbox(id, aggregate_id, │ ← same transaction
   │ event_type, payload,│
   │ status, created_at) │
   └──────────────┬──────────────┘
   │ inspectOutbox poller:
   │ FOR UPDATE SKIP LOCKED, LIMIT n
   ▼
   Kafka (key = aggregate_id)
   │
   ┌───────────┼───────────┐
   ▼ ▼ ▼
   Analytics Notification Mail
   Implementation choices, and what to say in an interview:

- Poller (SKIP LOCKED) — appropriate for you. Run it in the service on an interval; publish rows marked pending, then mark published.
- Debezium / logical decoding — the "industry" answer, but hard to demo in a portfolio and overkill here. Talk about it as "the path you'd take at scale," then say you chose the poller deliberately for simplicity.
- Postgres NOTIFY/LISTEN + fallback poller is a nice middle ground if you want to reduce latency.

7. Fire-and-Forget Publishing
   Honestly? For a demo/demo-README context, acceptable. For a production posture, no.
   What can go wrong:

- publish() throws if the producer isn't connected (producer.ts:61-63). Your .catch(console.error) then swallows it → silent loss.
- No retry, no acknowledgment handling, no dedup key → duplicates under retries.
- No visibility: you literally cannot tell a message was lost except by a log line.
  Production-oriented minimum:

1. Move the write-path publishes into the outbox (section 6) — the request handler stops publishing directly. This alone removes the failure mode.
2. For anything you do publish directly: await, verify isConnected(), retry with backoff.
3. Use KafkaJS's default acks: all (its default) + idempotent producer mode (KafkaJS enables idempotent: true by default) — and combine with consumer-side dedup to reach "at-least-once / effectively-once."
4. Consumer Failure Handling — Redesign
   Unify the three consumers onto one shared failure contract in @jtrack/shared:
   each message →
5. parse/validate → fail = poison pill → DLQ (never retry)
6. idempotency check → already processed (by event id) → skip
7. process → transient failure → retry with backoff (N times)
8. retries exhausted → DLQ with error reason + timestamp

- Mail consumer already approximates this — formalize it with a dedup step and structured DLQ reason.
- Analytics consumer (currently log + drop): adding idempotency is actually easy because your upsert is already naturally idempotent — increment is safe to re-apply. So the analytic consumer's real fix is "don't drop, and the upsert already dedups." That's a genuinely elegant point to make in an interview.
- Notification consumer (currently log + drop): naive retries would resend duplicate emails — so this is exactly where consumer-side dedup is mandatory (store a sent_events set / dedup table keyed by event id before sending).
  Don't build the full "retry topics with scheduled delay" topology. A shared retry-with-backoff-then-DLQ helper gives you 90% of the production story with 20% of the complexity, and it's one consistent pattern across three consumers — which is the real engineering signal.

9. Ideal J-Track Kafka Architecture (realistic)
   Auth Service Job Service
   │ outbox │ outbox (same DB txn as business write)
   ▼ ▼
   relay (poller, SKIP LOCKED, key = aggregate_id)
   │ │
   ▼ ▼
   send-mail job-events (key=job_id, 3 partitions)
   │ ├── job-analytics-group → Analytics
   │ │ (idempotent counters, retry→DLQ)
   │ └── notification-group → Notification
   │ (event-id dedup → email → retry→DLQ)
   ▼
   mail-service-group → Mail (validate, dedup, retry→DLQ)
   │
   ▼
   send-mail-dlq ← shaared DLQ path for all three consumers
   Each component and its purpose:
1. Outbox tables (per service with a DB) — write business state + event in one txn; guarantees at-least-once.
1. Relay — the poller publishing with correct partition keys; decouples "what happened" from "when it's delivered."
1. send-mail — async, retryable email; request path never touches SMTP.
1. job-events — the source of truth stream; two independent groups consume it = the fan-out demo.
1. Analytics — idempotent by construction (counter increments), retry→DLQ only for DB bursts.
1. Notification — dedup keyed on event id (prevents double-emails), retry→DLQ.
1. DLQ topics — one shared pattern: poison pills + exhausted retries land here with reason/timestamp.
   That's it. Three topics, three consumers, one reliability pattern, one outbox. It is smaller than "add lots of topics," and it demonstrates every concept on your checklist except those I told you to skip.
1. Implementation Roadmap
   Phase 1 — Must Have
1. Outbox on Job + Auth — prisma.$transaction, outbox table, poller (SKIP LOCKED) → Medium
1. Event IDs + idempotent consumers (mail dedup table, notification dedup) — Medium
1. DLQ + retry for analytics & notification via shared helper — Easy–Medium
1. Partition keys (job_id) on all job-events publishes — Easy
   Phase 2 — Strong Portfolio
1. Shared consumer failure pipeline (parse→dedup→retry→DLQ) extracted into @jtrack/shared so all 3 consumers use one helper — Medium
1. Consumer lag exposure — admin describeGroup/fetchOffsets in the health endpoint (offsets vs. end offsets) — Easy–Medium
1. Message version field + changelog in event payloads — Easy
1. Observability — correlation/log of publish+consume with event ids; maybe a Kafka span id — Easy
   Phase 3 — Optional (only if you want the talking points)
1. Retry topic with delayed delivery (separate retry topic + consumer) if you want to demo the real Kafka retry topology — Hard-ish, Medium value
1. Replace poller with Postgres NOTIFY/LISTEN + fallback polling to reduce outbox latency — Medium
1. Debezium CDC — impressive but genuinely overkill; only talk about it — Hard
   Skip: Kafka transactions, Schema Registry, EOS, event replay tooling.
1. Resume / Portfolio Descriptions (accurate, no inflation)
   One-line resume bullet:
   Built an event-driven job marketplace on Kafka with 3 topics, transactional outbox for reliable delivery, 3 independent consumer groups with idempotent processing, retries, and DLQ, powering analytics aggregation and async email.
   README description:
   Kafka event architecture. J-Track uses Apache Kafka for all cross-service async communication. Auth and Job services write business state + events atomically via a transactional outbox, and a polled relay publishes to job-events and send-mail with partition keys that preserve per-entity ordering. Three consumer groups process the stream independently: an analytics consumer upserts daily counter increments into job_analytics (idempotent by construction), a notification consumer sends recruiters real-time alerts (deduplicated by event ID), and a mail consumer delivers transactional email with retry + DLQ. A shared consumer helper enforces a uniform parse → dedup → retry → DLQ pipeline, and every consumer reports health + lag via the service health endpoint.
   Interview explanation (the 30-second version):
   "My Kafka usage serves three real needs: analytics aggregation, recruiter notifications, and async email. Job and Auth services never publish directly from the request path — I write the event into an outbox in the same transaction as the business write, and a poller using FOR UPDATE SKIP LOCKED publishes to Kafka with at-least-once semantics and keying by job_id for per-job ordering. Analytics and notification use separate consumer groups on the same job-events topic, which is the fan-out. Consumers are idempotent: analytics relies on commutative counter increments, notification dedups by event ID so retries can't double-send emails, and mail goes through retry-then-DLQ. I deliberately chose the polling outbox over Debezium for simplicity, and I skip Kafka transactions because I'd rather have honest at-least-once + idempotent consumers than claim exactly-once I can't really guarantee."
   Bottom line
   Your concern is half-warranted. The current implementation is a legit 7/10 and already better than ~90% of junior portfolios — the presence of fan-out, typed events, retry+DLQ, and health checks is real engineering, not decoration. The four improvements above (outbox, idempotency, unified DLQ, partition keys) push it to an honest 9/10 without growing the surface area, and each is a classic interview topic you can explain with real reasoning.
   If you want, we can go implement Phase 1 next — I'd start with the outbox on the Job service.
