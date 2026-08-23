# J-Track Kafka — Verification Report

> Final production-readiness verification of the Kafka implementation. Verified
> against the shipped kafkajs 2.x source and the codebase's own test suite.
> **Verdict: Production-ready with accepted limitations** (see §12, §13).

---

## 1. Current Kafka architecture

- **Topics:** `job-events` (job-service domain events), `send-mail` (auth email
  intents), plus DLQ topics `job-events-dlq` and `send-mail-dlq`. Auto-created on
  boot (`ensureTopic`), default 3 partitions; replication factor omitted unless
  `KAFKA_TOPIC_REPLICATION_FACTOR` is set (managed-broker-safe).
- **Producers:** auth-service (verification/reset emails, `send-mail`) and
  job-service (`job-events`) via a shared singleton producer
  (`packages/shared/src/kafka/producer.ts`), idempotent mode
  (`idempotent: true`, `maxInFlightRequests: 5`).
- **Consumers** (shared `createConsumer` factory): `job-analytics-group`
  (job-service) and `notification-group` + `mail-service-group` (utils-service)
  on `job-events` / `send-mail`. Each runs the uniform pipeline
  normalize → validate → dedup → handler → retry→DLQ → metrics.
- **Transactional outbox** (`packages/shared/src/kafka/outbox.ts`) on job and
  auth: business write + event row commit in the same DB transaction; a poller
  publishes rows to Kafka and marks them `SENT`. Used for events whose loss
  would be a correctness bug (`job.applied`, `application.status_changed`,
  `application.status_mail`, verification/reset emails).
- **Per-aggregate ordering:** publishes are keyed by aggregate id
  (`jobPartitionKey`/`applicantPartitionKey`) so events about one entity land in
  the same partition.

## 2. Production guarantees (what IS guaranteed)

- **At-least-once delivery** — Kafka's native semantics; nothing is dropped on
  the write path (outbox) or the consume path (uncommitted offsets are
  redelivered).
- **No duplicate business effects** — consumers are idempotent: analytics dedups
  transactionally (`markProcessedInTx`, same `$transaction`); mail and
  notification dedup via the `(consumerId, eventId)` unique guard
  (`consumer_dedup`). Replays and redeliveries cannot double-count or
  double-send, except the documented check-then-mark window (§12).
- **Transactional publish** — an event is either published or visible as
  `PENDING`/`FAILED` in the outbox; it is never lost between DB write and Kafka
  write.
- **Bounded retry then DLQ** — transient failures retry with exponential backoff
  + jitter (`maxAttempts` 3, 1s→15s); permanent failures and poison pills land
  in the DLQ with full context (envelope, original topic/partition/offset,
  error, reason) and can be replayed.
- **Per-aggregate ordering** — within a partition; no global ordering claimed.
- **Observable failure** — every dead-letter is visible on a DLQ topic, every
  stuck event is visible in the outbox, and health/readiness endpoints expose
  Kafka dependency state (§8).

## 3. The 9 defects found and fixed

| # | Defect | Fix |
|---|--------|-----|
| 1 | Direct publish was fire-and-forget with swallowed errors; a disconnect made `publish()` throw → silent event loss with no signal | Direct publishes awaited + caught; `job.viewed` is now an explicit, logged best-effort (§4); auth publishes are awaited and connection-verified |
| 2 | Producer `connected` flag went stale forever on a silent broker drop (`producer.disconnect` never fires on drops) → dead session reused, every later publish failed | `publish()` re-checks connectivity and reconnects before send; a retryable `send()` error invalidates `connected` so the next publish establishes a fresh session (`producer.ts`) |
| 3 | Concurrent `publish()` calls could each trigger `connect()` → duplicate connections | In-flight `PENDING_CONNECTIONS` map dedupes concurrent connects; `connect()` is idempotent and backoff-bounded |
| 4 | A rethrown handler error (e.g. DLQ-write failure) stopped the kafkajs consumer with no operator signal; readiness could report 200 while the consumer was dead (`consumer.run()` resolves early, so a try/catch never saw the crash) | Consumer factory listens on `consumer.crash`: `restart === false` flips `running=false` → readiness 503 + clear error log; process stays alive; message stays uncommitted → redelivered on restart (`consumer-factory.ts`) |
| 5 | Consumers trusted payloads; malformed/unknown events were processed blindly or dropped silently | `validation.ts` + `EVENT_VALIDATORS` for all 6 produced types; `validateEventEnvelope` runs after normalization, before the handler; unknown type / unsupported version / invalid payload → non-retryable → DLQ |
| 6 | DLQ write was a single `send()` — a transient broker blip silently lost the dead-letter record | `publishToDLQ` retries `KAFKA_DLQ_PUBLISH_RETRIES` (default 3) with backoff; on final failure the consumer rethrows so the offset is **not** committed and the message is redelivered (`dlq.ts`) |
| 7 | Outbox publish dropped envelope metadata (eventId/eventType/eventVersion/correlationId/partitionKey) → consumers lost identity, correlation, and ordering | `processClaimed` passes the full envelope metadata through to the producer (`outbox.ts`); added outbox ops tooling for stuck rows (§10) |
| 8 | Lag with no committed offset (broker returns -1) was silently reported as an exact lag value = full partition length | `ConsumerLag` gained `hasCommittedOffset`; uncommitted groups are flagged as an **upper bound**, not an exact measure (`consumer.ts`) |
| 9 | `/health` conflated liveness and readiness — CI/e2e asserted 200, so a Kafka-down service still looked healthy and orchestrators couldn't distinguish "alive but degraded" from "dead" | Split endpoints on all services: `/health` = liveness (process + uptime, 200 while alive); `/health/ready` = readiness (200/503 based on Kafka dependency + consumer `running`) (§8) |

Defect 4 was the one surfaced **during** the final verification pass (the
readiness false-positive), then fixed and covered by tests.

## 4. `job.viewed` — intentional best-effort exception

`job.viewed` is the single event published directly (not via outbox):
`jobs.controller.ts:547`, keyed by `jobPartitionKey`, with correlation ID. It is
a **count metric**: occasional loss is acceptable, so an exception is caught and
logged rather than failing the request. Every other produced event goes through
the outbox (§1).

## 5. DLQ failure behavior and recovery procedure

Verified against kafkajs 2.x behavior. This is the one case that stops a
**consumer** (not just a message):

- A DLQ-write failure that survives in-place retries is **rethrow from
  `eachMessage`**. kafkajs refuses to commit the failed message's offset and
  halts **all** fetchers for that consumer; for a non-retriable crash there is
  **no auto-restart** — the consumer stays stopped.
- Only offsets for successfully processed messages are committed (kafkajs
  commits the resolved offsets up to the first failure) — nothing is lost.
- The **process stays alive**: liveness `/health` 200; readiness `/health/ready`
  503 (`connected: false`), because the factory flips `running=false` on
  `consumer.crash` with `restart === false`.
- **Recovery procedure: restart the service.** The consumer resumes from the
  last committed offset; any in-flight/failed message is redelivered
  (at-least-once) and idempotency prevents duplicate effects.
- No duplicate class beyond normal at-least-once: fully applied + committed
  messages are never reprocessed; the only re-send risk is the check-then-mark
  window (§12).

## 6. Producer reconnect behavior

- kafkajs `producer.connect`/`disconnect` events fire **only** on explicit
  `connect()`/`disconnect()` calls — never on a broker drop.
- Real broker-drop recovery is internal to kafkajs `send()`: it retries the
  request, re-runs `cluster.connect()` (idempotent) + metadata refresh, bounded
  by `retry { retries: 10 }` with backoff.
- Our hardening adds self-heal **after** those retries are exhausted: a retryable
  `send()` error flips the producer to `disconnected`, so the next `publish()`
  issues an explicit `connect()` first (§3 #2). No reconnect storm — kafkajs
  retries and our backoff are both bounded; the per-`clientId` singleton plus the
  in-flight connect map dedupe concurrent attempts.
- DLQ writes ride the same producer hardening (§3 #6).

## 7. Event validation / versioning

- Every envelope carries `eventType` + `eventVersion` (default 1) + `eventId` +
  `correlationId`.
- All **6 produced eventTypes** are covered by validators:
  `job.viewed`, `job.applied`, `application.status_changed` (job-events) and
  `VERIFY_EMAIL`, `RESET_PASSWORD`, `application.status_mail` (send-mail).
- Validation runs on consume after normalization and before the handler. Failures
  are **non-retryable** by definition (retrying cannot fix them) → DLQ.
- Evolution rule: a new `eventVersion` is **added** to a validator's `versions`
  array (never removed); older versions remain supported. No Schema Registry —
  the catalogue is 6 types with hand-written structural validation.
- Legacy (pre-envelope) messages are wrapped in a synthetic envelope with a
  deterministic SHA-256 `eventId`, so even old messages can be validated and
  deduplicated.

## 8. Liveness vs readiness

- `GET /health` — **liveness**: process + uptime. Always 200 while the process is
  alive, so Kafka-down ≠ dead.
- `GET /health/ready` — **readiness**: 200 only when the service's Kafka
  dependency is healthy (producer broker + topics for auth/job; consumers
  connected + lag for utils/job). 503 otherwise.
- A dead consumer (non-restartable crash) ⇒ readiness 503; a broker outage ⇒
  readiness 503 and auto-recovers when Kafka returns. Liveness stays 200 in both
  cases.

## 9. Consumer lag behavior

- `getConsumerLag(clientId, groupId, topics)` reads **broker truth**
  (`admin.fetchOffsets` vs `admin.fetchTopicOffsets`), not an in-process guess.
- `lag = highWatermark − committedOffset`.
- **No committed offset** (fresh group): broker returns -1 →
  `hasCommittedOffset: false` and `lag` is the full partition length — an
  **upper bound**, not an exact "behind" measure. Treat it as "at most".
- Empty partition ⇒ lag 0. Disconnected consumers still report real lag (offsets
  live on the broker). Lag failures degrade observability, never crash the
  caller (returns `undefined`).

## 10. Outbox FAILED recovery

- Non-retryable publish failures or exhausted `OUTBOX_MAX_ATTEMPTS` (default 5)
  mark a row `FAILED` with `lastError`; `PROCESSING` claims older than 30s are
  swept back to `PENDING`.
- **Operational tooling:** `scripts/outbox.ts` (`pnpm outbox`)
  — `outbox list` to inspect stuck rows, `outbox reset` to flip
  `FAILED` → `PENDING`. Reset preserves `eventId`/`eventType`/`partitionKey`/
  `correlationId`; the worker then claims and publishes with the original
  `eventId`, and consumer idempotency makes re-resetting safe (no duplicate
  business effect even if a previous attempt already reached Kafka).
- Only retry a `FAILED` row after confirming the root cause (the `lastError`)
  won't fail again, otherwise it will fail again immediately.

## 11. Test evidence

- **211 tests pass**, `pnpm lint` (tsc `--noEmit` across all packages) 0 errors,
  `pnpm build:shared` succeeds.
  - shared **89** (consumer-factory 12 incl. crash/readiness, dlq-replay,
    producer, outbox, validation, metrics, consumer/lag, envelope, correlation,
    partitioning, idempotency)
  - auth **32**, jobservice **28**, user **19**, utils **43**.
- Test types, honestly labeled:
  - **Unit with faked Kafka** (fake consumer/producer objects): consumer-factory,
    producer, dlq, outbox, envelope, correlation, metrics, validation.
  - **Mocked kafkajs admin** (lag): `consumer.test.ts`.
  - **Failure-path tests** (simulated DLQ failure, retries exhausted, validation
    rejection, `consumer.crash` events): consumer-factory, dlq-replay,
    validation, metrics.
  - **Real-Kafka integration tests: none** — no broker in CI. Runtime claims
    (offset not committed, consumer halts, producer events only on explicit
    calls, send()-internal reconnect) were verified by reading the kafkajs
    2.x source that ships in `node_modules`, not by a live broker.
  - **DB-backed outbox ops were not run against real Postgres** in this pass.

## 12. Accepted limitations

1. **No real-Kafka integration test suite** — behavior verified against source
   + mocked/faked unit tests only.
2. **No real Postgres/broker outbox exercise** in this pass — outbox ops are
   unit-tested and the CLI typechecks.
3. **SMTP check-then-act re-send window** — a crash between send and
   `markProcessed` re-sends on redelivery (inherent to at-least-once external
   effects). Mail and notification dedup before the effect, which shrinks but
   does not eliminate the window.
4. **Manual restart after a permanent consumer crash** — a non-restartable crash
   (e.g. DLQ-write failure after in-place retries) stops the consumer; recovery
   is restart the service (§5). Safe and visible, but an operational action.
5. **Mocked Kafka admin for lag tests** — `consumer.test.ts` mocks kafkajs
   admin; no live-broker lag validation.
6. **Best-effort `job.viewed`** — intentional (§4).
7. **No Prometheus/OTel** — metrics are in-process counters; lag is
   best-effort broker metadata, not a real-time dashboard.
8. **Single-broker dev default** — production should set multiple brokers +
   SASL/SSL (supported in `resolveKafkaConfig`).

## 13. What this system does NOT guarantee

- **Exactly-once delivery or processing.** It is at-least-once + idempotent
  consumers ("effectively once" for committed effects).
- **Exactly-once SMTP sending.** A crash between send and mark can re-send.
- **Global ordering.** Ordering holds per partition (per aggregate), never across
  partitions.
- **Zero event loss under simultaneous handler + DLQ failure.** If the DLQ write
  itself fails, the message stays uncommitted and is redelivered only after a
  service restart — it is not lost, but it is not processed until then.
- **Real-time lag dashboards.** Lag is best-effort broker metadata surfaced via
  readiness/metrics, not a monitoring product.
- **Kafka transactions / consume-produce.** The outbox gives transactional
  *publish*, not transactional *consume-produce*.

## 14. Final verdict

**Production-ready with accepted limitations.** The pipeline is correct by
construction and by source verification; the one real defect surfaced during
verification (readiness false-positive on consumer death) is fixed and tested.
The remaining limitations (§12) are documented, accepted trade-offs — not
reasons to redesign. No further Kafka features are planned unless a future
requirement exposes a real problem.

---
Related: [`kafka-architecture.md`](kafka-architecture.md) (full design),
[`kafka/`](kafka/) (walkthroughs), `KAFKA_ARCHITECTURE_REVIEW.md` (original
7/10 review this hardening came from).