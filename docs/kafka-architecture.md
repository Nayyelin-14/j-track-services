# j-track Kafka Architecture

> Async event backbone for the j-track microservices platform.
> **Delivery guarantee: at-least-once** (Kafka's native semantics) made safe by
> **idempotent consumers**. We do not claim exactly-once delivery.

---

## 1. Scope & goals

j-track publishes events when interesting things happen (applications, job
views, application status changes, verification/reset emails) so that separate
services can react without blocking the HTTP request that caused the event:

- The **job service** emits structured events for analytics and notifications.
- The **auth service** emits email-intent events (verification, password reset).
- The **utils service** consumes email events and job events to send Nodemailer
  mail and recruiter alerts.

Design goals, stated so a reviewer can check them:

1. **Transactional outbox** — a DB write and its "publish event" are atomic.
2. **At-least-once + idempotent consumers** — no message is ever lost; a
   redelivered message does not double-apply business effects.
3. **Consumer-side retry + DLQ + replay** — transient failures self-heal, and
   permanent failures are never silently dropped.
4. **Ordering per aggregate** — all events about one job/applicant land in the
   same partition, so they are consumed in order.
5. **Observability** — correlation IDs span request → event → consumer; in-process
   metrics counters are exposed via logs/health.
6. **Bounded risk** — defaults favor correctness and debuggability over throughput.
7. **Honest scaling** — a single shared consumer pipeline; scaling is done by
   adding consumer instances per group, each owning disjoint partitions.

---

## 2. Component map

```
        ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
        │   Auth     │  │    User    │  │    Job     │  │   Utils    │
        │  :7000     │  │   :7001    │  │   :7002    │  │   :6001    │
        └─────┬──────┘  └────────────┘  └─────┬──────┘  └─────┬──────┘
              │  publish (send-mail)          │               │
              │  correlationId+eventType      │  enqueue /    │
              │                               │  publish      │
              ▼                               ▼               ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                       Apache Kafka                            │
        │   topic send-mail      job-events      *-dlq (DLQ)           │
        └──────────────────────────────────────────────────────────────┘
              ▲                               ▲               ▲
              │ mail-service-group            │ job-analytics-group
              │ (utils)                       │ (job service)
              │                               │ notification-group
              │                               │ (utils)
              └─ consumer_factory: normalize → correlation → retry→DLQ → metrics
```

Producers:
- `auth-service` — raw `publish()` to `send-mail` (verification, reset).
- `job-service` — transactional outbox for `job.applied`/`application.status_changed`
  and a direct `publish()` for `job.viewed` (fire-and-forget analytics), both to
  `job-events`.

Consumers (shared `createConsumer` pipeline, one handler each):
- `job-analytics-group` → `job-analytics` consumer (job service) on `job-events`.
- `notification-group` → `notification-service` consumer (utils service) on `job-events`.
- `mail-service-group` → `mail-service` consumer (utils service) on `send-mail`.

---

## 3. Topics & consumer groups

| Topic | Producer | Purpose |
|-------|----------|---------|
| `job-events` | job-service | Domain events: `job.viewed`, `job.applied`, `application.status_changed` |
| `send-mail` | auth-service | Email-intent events (verification, password reset) |
| `send-mail-dlq` | utils (DLQ writer) | Dead-letter queue for failed mail sends |
| `job-events-dlq` | job/utils (DLQ writer) | Dead-letter queue for failed job-event processing |

| Consumer group | Members | Topic(s) | Consumer ID (dedup scope) |
|----------------|---------|----------|-----------------------------|
| `job-analytics-group` | job service | `job-events` | `job-analytics` |
| `notification-group` | utils service | `job-events` | `notification-service` |
| `mail-service-group` | utils service | `send-mail` | `mail-service` |
| `kafka-replay` | CLI (on demand) | a DLQ topic | n/a (reads DLQ only) |

Topics are auto-created on service boot via `ensureTopic`. DLQ topics exist so
never a replayed/failed message is mixed with the live business topic.

---

## 4. Producer architecture

### 4.1 Shared producer (`packages/shared/src/kafka/producer.ts`)

`getKafkaProducer(clientId)` returns a singleton `ProducerInstance` per clientId:

- **Idempotent producer** — `{ idempotent: true, maxInFlightRequests: 5 }`. Within
  Kafka this dedupes at the broker level, but our end-to-end guarantee is still
  at-least-once + consumer idempotency.
- **Auto-envelope** — `publish(topic, message, options)` wraps every payload in an
  `EventEnvelope` unless it is already envelope-shaped (Phase 3):
  - `eventId` from `options.eventId`, else a fresh UUID,
  - `eventType` from `options.eventType` → payload `type` → `"unknown"`,
  - `eventVersion` default `1`,
  - `source` = `options.source` ?? `clientId`,
  - `correlationId` set on the envelope **and** as a Kafka message header.
- Lazily connects with exponential backoff; reuses the registered client.
- **Verified reconnect reality (kafkajs 2.x):** `producer.connect`/`disconnect`
  instrumentation events fire **only** on explicit `connect()`/`disconnect()`
  calls, never when a broker drops. Real recovery on a broker drop happens inside
  `producer.send()`: kafkajs retries the request, re-runs
  `cluster.connect()` (idempotent) + metadata refresh, then rethrows — bounded by
  `retry { retries: 10 }` with backoff. Our hardening adds self-heal **after**
  those retries are exhausted: a retryable `send()` error flips the producer to
  `disconnected`, so the next `publish()` issues an explicit `connect()` first.
  There is no reconnect storm — both the kafkajs retrier and our backoff are
  bounded, and the per-`clientId` singleton plus an in-flight `PENDING_CONNECTIONS`
  map dedupes concurrent connect attempts.
- **DLQ publish hardening** — writes to the DLQ topic go through the same
  producer; a transient DLQ-write failure is retried `KAFKA_DLQ_PUBLISH_RETRIES`
  times (default 3) with backoff **before** the consumer rethrows (so a hiccup on
  the DLQ broker doesn't immediately stop consumption).

### 4.2 Transactional outbox (`packages/shared/src/kafka/outbox.ts`)

Used for events whose loss would be a correctness bug (job applications, status
changes). Flow:

1. **Enqueue (in the business transaction)**
   `enqueueOutboxEvent(tx, …)` writes a `PENDING` row to `outbox_events` (with
   `eventId`, `eventType`, `eventVersion`, `topic`, `partitionKey`, `source`,
   `correlationId`, `payload`) **in the same DB transaction** as the business write.
2. **Claim** — `claimOutboxBatch` selects the oldest `PENDING` rows whose
   `availableAt` has passed, then atomically (`updateMany … where status=PENDING`)
   marks them `PROCESSING` with `claimedBy`/`claimedAt` (a compare-and-set claim).
3. **Publish** — `processClaimed` publishes each event through the shared producer
   (preserving envelope metadata + partition key) and flips the row to `SENT`.
4. **Retry** — transient publish failures put the row back to `PENDING` with an
   exponential + jitter `availableAt` (`OUTBOX_RETRY_BASE_MS`/`_MAX_MS`,
   default 1s→60s). Non-retryable failures or max attempts (`OUTBOX_MAX_ATTEMPTS`,
   default 5) mark the row `FAILED` with `lastError`.
5. **Sweep** — a periodic sweep finds `PROCESSING` claims older than
   `OUTBOX_PROCESSING_TIMEOUT_MS` (30s) — e.g. from a crashed worker — and
   returns them to `PENDING` so another worker can pick them up.

Guarantee: an event is either published to Kafka or stuck in a visible DB state
(`PENDING`/`FAILED`), never lost between DB write and Kafka write.

(There is an orphan `outbox_events` table from a Phase‑2 experimental migration —
see *Risks & limitations*.)

### 4.3 Direct publish (no outbox)

`job.viewed` is published directly (not via outbox):
`jobs.controller.ts:547` `kafka.publish("job-events", …)` with
`key: jobPartitionKey(job_id)` and `correlationId: getCorrelationId()`. It is a
count metric, so best-effort is acceptable — an exception is caught and logged
rather than failing the request.

---

## 5. Event envelope (`packages/shared/src/kafka/envelope.ts`)

```
EventEnvelope {
  eventId: string;         // stable identity → idempotency key
  eventType: string;       // stable semantic name
  eventVersion: number;    // payload revision (default 1)
  occurredAt: string;      // ISO timestamp
  source: string;          // producing client
  correlationId?: string;  // opaque trace ID
  payload: TPayload;       // verbatim business data
}
```

- Producers always write envelopes (auto-wrap in `producer.publish`, outbox rows
  carry the envelope fields directly).
- Consumers always read through `normalizeKafkaMessage`, which accepts legacy
  (pre-envelope) messages and wraps them in a synthetic envelope with a
  deterministic (SHA-256) `eventId` so even old messages can be deduplicated.
  See `docs/kafka-schema-evolution.md` (Phase 11).
- Typed event aliases live in `events.ts` (`job.applied`, `job.viewed`,
  `application.status_changed`).

---

## 6. Idempotent consumers / `consumer_dedup`

### 6.1 Why

Kafka redelivers when a consumer crashes after processing but before committing
the offset, and **replay** (from the DLQ) intentionally re-publishes messages.
Without idempotency, redelivery double-applies effects (double email, double
view counter). We record which events each consumer has already handled.

### 6.2 Storage

`consumer_dedup` table (Phase 4, migration `20260813010000_add_consumer_dedup`):
```
consumerId + eventId  → UNIQUE (the idempotency key)
partition, offset     → diagnostic info
processedAt           → retention pruning
occurredAt            → event timestamp
```

### 6.3 Two idempotency idioms

Helpers in `packages/shared/src/kafka/idempotency.ts`:

- **Transactional (DB effect):** the analytics consumer runs the dedup
  `INSERT` **and** the `job_analytics` upsert in the **same** DB transaction
  (`markProcessedInTx` + `prisma.$transaction`). A redelivered eventId hits the
  unique constraint `inside` the transaction → the whole transaction is rejected
  and reports `isDuplicate` → no double-count.
- **Check-then-mark (external effect):** mail & notification consumers first
  `isAlreadyProcessed`, then perform the SMTP send, then `markProcessed`. This is
  at-least-once by construction: a crash between send and mark means a re-send on
  redelivery (documented, accepted). Optionally the handler marks *before* the
  effect and deletes the row on failure for stricter semantics.

Consumers that skip a message in a handler (e.g. job not found) deliberately
`markProcessed` to stop infinite redelivery.

`pruneProcessedRecords` (default retention 7 days) keeps the dedup table bounded.

---

## 7. Retry & backoff (consumer side)

`packages/shared/src/kafka/dlq.ts`:

- **Classification** `isRetryableError(err)`: retryable = transient
  infra/dependency failures (ECONN*/ETIMEDOUT/EAI_AGAIN, Prisma connection codes
  `P1001/P1002/P1008/P2028/P2024`, KafkaJS connection/timeout classes, message
  text matching connection/timeout patterns). **Everything else defaults to
  non-retryable** — a bug or bad payload should go straight to the DLQ to be
  inspected, not be retried blindly.
- **Bounded retry loop** `runWithRetryAndDlq(record, handler, policy)`:
  up to `maxAttempts` (default 3) with exponential backoff + jitter
  (`KAFKA_CONSUMER_RETRY_BASE_MS` 1s → `KAFKA_CONSUMER_RETRY_MAX_MS` 15s).
  `onRetry`/`onGiveUp` hook metrics.
- After exhaustion (or non-retryable), the record is written to the DLQ topic
  with full context: envelope (eventId + correlationId preserved), original
  topic/partition/offset, `consumerId`, error, attempts, reason.

Outbox publish retry is separate (`isRetryablePublishError` + `retryDelayMs`,
§4.2).

### 7.1 What happens when the DLQ topic itself is down

Verified against kafkajs 2.x behavior, this is the one case that **stops a
consumer** (not just a single message):

- A DLQ-write failure that survives the in-place retries is **rethrown** from
  `eachMessage`. kafkajs then refuses to commit the failed message's offset and
  halts **all** fetchers for the consumer (`runner`/`worker` propagation); for a
  non-retriable crash there is **no auto-restart** — the consumer stays stopped.
- Offsets are committed only for messages that succeeded (kafkajs commits the
  **resolved** offsets up to the first failure), so nothing is lost.
- The **process stays alive** — liveness `/health` stays 200; readiness
  `/health/ready` reports **503** (`connected: false`) because the consumer's
  `running` flag flips to false on the `consumer.crash` event
  (`restart === false`).
- **Recovery procedure:** restart the service (deployment/`docker compose
  restart`). The consumer resumes from the last committed offset, and any message
  that was in flight or failed is **redelivered** (at-least-once) — consumer
  idempotency prevents duplicate business effects.
- No duplicate class beyond normal at-least-once: a message whose effect was
  fully applied and committed is never reprocessed; the only re-send risk is the
  documented check-then-mark window for external effects (see §15).

---

## 8. DLQ & replay

### 8.1 DLQ record format

Each DLQ message is:
```json
{
  "v": 1,
  "envelope": { /* original envelope, eventId+correlationId intact */ },
  "originalTopic": "job-events",
  "partition": 2,
  "offset": "100",
  "consumerId": "job-analytics",
  "error": "…",
  "attempts": 3,
  "reason": "max_attempts_reached | non_retryable_error",
  "failedAt": "…"
}
```

### 8.2 Replay CLI

`scripts/kafka-replay.ts` (root script `pnpm kafka:replay`):
```
tsx scripts/kafka-replay.ts --dlq-topic job-events-dlq \
    --consumer-id job-analytics --limit 500
```
- Reads the DLQ with a **dedicated** group (`kafka-replay`) so live consumers'
  committed offsets are untouched.
- Filters by `consumerId` / `originalTopic`; re-publishes to the original topic.
- **Preserves the original envelope** (`eventId`/`correlationId`) — idempotent
  consumers will deduplicate against their `consumer_dedup` rows.
- Terminates on quiescence (partition drained) or `--limit`.
- `parseDlqMessage` ignores malformed records (counts as `invalid`, warned).

### 8.3 When to replay

- Consumer recovered from an outage and you want to catch up (usually not needed —
  Kafka redelivery already covers live consumption).
- A bug was fixed and the `FAILED`/DLQ batches should be re-processed.
- Mail send infra was down and the `send-mail-dlq` accumulated.

---

## 9. Partitioning & ordering (`packages/shared/src/kafka/partitioning.ts`)

- Kafka guarantees order **within a partition**, not across partitions.
- Keys are derived from the **aggregate id**, so every event about one job
  (`jobPartitionKey(job_id)` → `job-<id>`) or one applicant
  (`applicantPartitionKey(applicant_id)` → `applicant-<id>`) lands in the same
  partition → processed in order.
- `job.viewed` direct publish uses the job key; outbox rows carry `partitionKey`
  which the worker passes as the Kafka key.
- We explicitly do **not** claim cross-partition (global) ordering.

---

## 10. Consumer scaling

- All consumers are built by the shared `createConsumer` factory
  (`consumer-factory.ts`), which enforces one consistent pipeline:
  normalize → correlation context → `shouldProcess` filter → handler (dedup left
  to the handler) → retry→DLQ → metrics.
- Because handlers are **stateless** (no per-instance state; business state lives
  in Postgres), consuming instances are horizontally interchangeable.
- To scale: run more instances of the same service with the **same `groupId`**.
  Kafka rebalances partitions across members. To be correct with our key scheme,
  the per-partition `job-<id>` ordering must be preserved; since a single instance
  owns a whole partition at a time, it is.
- Per-group dedup keys mean scaling out cannot double-apply (the unique
  `(consumerId, eventId)` guard is instance-independent).

---

## 11. Correlation IDs (`packages/shared/src/kafka/correlation.ts`)

- Node `AsyncLocalStorage` propagates a correlation ID across async boundaries.
- Express middleware adopts inbound `x-correlation-id` or mints one, and echoes
  it in the response header.
- The flow: HTTP request → business operation → outbox row (`correlationId`)
  → envelope → consumer context → consumer logs and downstream DB work.
- Consumers run each message handler via `runWithCorrelation(envelope.correlationId)`,
  so consumer logs are traceable to the originating request.

---

## 12. Observability & metrics (`packages/shared/src/kafka/metrics.ts`)

No external monitoring dependency (per approved architecture; defer
Prometheus/OTel). Instead, in-process counters:

`getMetrics(clientId).snapshot()`:
`processed, failed, retries, dlq, deduped, totalProcessingMs, outboxPending,
outboxFailed, startedAt`.

- Consumers call `recordProcessed/recordFailed/recordRetry/recordDlq/recordDeduped`.
- Dedup hits and duplicate skips are counted (`recordDeduped`) and logged.
- Health endpoints surface Kafka health (`checkKafkaHealth`: broker + topic
  metadata, plus consumer `running`/lag) on **`/health/ready`** — readiness
  returns 200 only when the service's Kafka dependency (producer broker for job;
  consumers for utils) is healthy. **`/health`** is liveness-only (process + uptime,
  always 200 while alive), so orchestrators can distinguish "alive but not ready
  (Kafka down)" from "dead".
- Future work: export snapshots to an aggregation-safe endpoint or Prometheus.

---

## 13. Schema evolution (summary)

- Envelope format is forward and backward tolerant; legacy messages are wrapped
  with deterministic synthetic IDs at consume time. Full policy in
  `docs/kafka-schema-evolution.md` (Phase 11).
- Consumers are upgraded before producers during rolling deploys.

---

## 14. Failure recovery map

| Scenario | What happens | Recovery |
|----------|--------------|----------|
| Producer down on publish | Outbox rows stay/return to `PENDING` with backoff; direct `job.viewed` logs error | Kafka reconnect w/ backoff; outbox worker retries until `maxAttempts` |
| Worker crashes mid-publish (outbox) | Row left `PROCESSING` | Sweep returns it to `PENDING` (30s timeout), another claim publishes it |
| Consumer crashes mid-handle | Offset not committed; Kafka redelivers | Dedup prevents double effects |
| Transient consumer error (DB/Kafka down) | Bounded retries w/ backoff, then DLQ | Replay from DLQ after infra recovers |
| Non-retryable error (bad payload/bug) | Direct to DLQ | Inspect, fix, replay |
| **DLQ topic down at write time** | In-place retries, then consumer rethrows → kafkajs stops the consumer (offset uncommitted) | **Restart the service**; resumes from last committed offset, failed message redelivered & deduped |
| **Broker dropped for a producer** | kafkajs reconnects + retries `send()` internally (`retries: 10`); after exhaustion producer marks itself `disconnected` and reconnects explicitly on next publish | Automatic; bounded backoff, no storm |
| Mail SMTP down | `sendWithRetry` + consumer retry → DLQ | Replay `send-mail-dlq` |
| Duplicate delivery / replay | Unique `(consumerId, eventId)` | Deduplicated silently, counted |
| Analytic double-count | Same-transaction dedup constraint | Rolled back atomically |
| Dedup table growth | `processedAt` index + `pruneProcessedRecords` (7d) | Cron or periodic call |

---

## 15. Risks & limitations

1. **At-least-once only** — we never claim exactly-once. External-effect handlers
   (SMTP) are check-then-mark; a crash between send and mark re-sends.
2. **KafkaJS idempotent-producer warning** — KafkaJS logs "Limiting retries for
   the idempotent producer". This is benign for our config (finite connect
   retries; the producer is a wrapper for an at-least-once pipeline, not EoS
   transactional-consume-produce).
3. **Orphan `outbox_events` rows** — the phase-2 experimental `processed_events`
   table was dropped, but a small number of legacy `outbox_events` rows may still
   exist from that era. They are inert (no worker reads them).
4. **No Prometheus/OTel** — metrics are in-process counters only.
5. **`pruneProcessedRecords` is not scheduled** — it's a helper; deployers must
   call it periodically (cron) to bound `consumer_dedup`.
6. **`notification-service` requires job+recruiter lookups** — a missing
   job/recruiter marks the event processed (skipped) rather than DLQ-ing it, by
   design.
7. **Single-broker dev default** — local `KAFKA_BROKER=localhost:9092`; production
   should configure multiple brokers + SASL/SSL (supported in `resolveKafkaConfig`).
8. **No producer-side transaction/consume-produce** — the outbox gives
   transactional *publish*, not transactional *consume-produce*.
9. **A permanent consumer crash requires a service restart** — a non-retriable
   crash (notably a DLQ-write failure after in-place retries) stops the consumer
   with no auto-restart. This is safe (offset uncommitted → redelivery + dedup)
   and *visible* (readiness 503, `consumer.crash` logged with
   `restart: false`), but it is an operational action, not self-healing (§7.1).
10. **Consumer-lag accuracy** — `getConsumerLag` reports a partition's lag as
    `highWatermark - committedOffset`. When a group has **no committed offset yet**
    (`committedOffset === -1`) the value is an upper bound of the true lag and is
    flagged with `hasCommittedOffset: false`; treat such values as "unknown/at
    most", not exact. Lag is measured from broker metadata (fetchOffsets /
    fetchTopicOffsets), so it is best-effort diagnostic info.

---

## 16. Config surface (env vars)

| Var | Default | Used by |
|-----|---------|---------|
| `KAFKA_BROKER` | `localhost:9092` | all |
| `KAFKA_CONNECTION_TIMEOUT` / `KAFKA_AUTH_TIMEOUT` | `10000` | all |
| `KAFKA_RETRY_INITIAL_TIME` / `KAFKA_RETRY_COUNT` | `300` / `10` | all |
| `KAFKA_SSL`, `KAFKA_SASL_MECHANISM/_USERNAME/_PASSWORD` | — | all (cloud) |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `1000` / `10` | job |
| `OUTBOX_MAX_ATTEMPTS` / `OUTBOX_PROCESSING_TIMEOUT_MS` | `5` / `30000` | job |
| `OUTBOX_SWEEP_INTERVAL_MS` / `OUTBOX_RETRY_BASE_MS` / `OUTBOX_RETRY_MAX_MS` | `15000` / `1000` / `60000` | job |
| `KAFKA_CONSUMER_MAX_ATTEMPTS` | `3` | all consumers |
| `KAFKA_CONSUMER_RETRY_BASE_MS` / `KAFKA_CONSUMER_RETRY_MAX_MS` | `1000` / `15000` | all consumers |
| `KAFKA_JOB_EVENTS_TOPIC`, `KAFKA_ANALYTICS_GROUP`, `KAFKA_ANALYTICS_DLQ_TOPIC` | `job-events`, `job-analytics-group`, `job-events-dlq` | job analytics |
| `KAFKA_CONSUMER_GROUP`, `KAFKA_MAIL_TOPIC`, `KAFKA_DLQ_TOPIC` | `mail-service-group`, `send-mail`, `send-mail-dlq` | utils mail |
| `KAFKA_NOTIFICATION_GROUP`, `KAFKA_NOTIFICATION_DLQ_TOPIC` | `notification-group`, `job-events-dlq` | utils notification |

---

## 17. Verify in this repo

```
pnpm --filter shared run build     # prisma generate + tsc (shared lib)
pnpm --filter shared test          # 82 tests (envelope/outbox/idempotency/dlq/replay/validation/producer/…) 
pnpm outbox --help                 # outbox inspect/retry CLI usage
pnpm --filter auth exec vitest run # 32
pnpm --filter jobservice exec vitest run  # 28
pnpm --filter user exec vitest run # 19
pnpm --filter utils exec vitest run # 43
pnpm kafka:replay --help           # replay CLI usage
```

Migrations (applied against the DB):
`20260813010000_add_consumer_dedup` (adds `consumer_dedup`, drops orphan
`processed_events`).