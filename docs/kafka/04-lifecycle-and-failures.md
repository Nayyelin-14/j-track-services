# 04 — Lifecycle, Idempotency, Retry, DLQ, Replay, Metrics (pipeline detail)

## 1. The transactional outbox (job service reliability)

**Problem:** if we publish to Kafka and then the DB commit fails (or vice versa),
we have an inconsistent state — an event that never happened but was announced,
or a business change with no event.

**Solution — write the event inside the same DB transaction:**

```
prisma.$transaction(async (tx) => {
  await tx.application.create(...)        // business write
  await enqueueOutboxEvent(tx, {...})     // PENDING row in outbox_events
})                                        // BOTH commit or BOTH roll back
```

The **outbox worker** (`startOutboxWorker` in `packages/shared/src/kafka/outbox.ts`)
does:

| Step | Code | Behavior |
|------|------|----------|
| Claim | `claimOutboxBatch` | picks `PENDING` rows up to `batchSize`, flips to `PROCESSING` + records `claimedBy`/`attempts` — uses `updateMany WHERE status='PENDING'` so two workers can't claim the same rows |
| Publish | `processClaimed` | `kafka.publish(topic, payload, { key, eventId, correlationId, eventType, ... })` → success sets `SENT` |
| Retry | same fn | retryable error + `attempts < max` → back to `PENDING` with `availableAt = now + delay` (exp. + jitter) |
| Fail | same fn | exhausted / non-retryable → `FAILED` + `lastError` |
| Sweep | `sweepStaleClaims` | rows stuck in `PROCESSING` longer than `OUTBOX_PROCESSING_TIMEOUT_MS` → back to `PENDING` (another worker picks them up) |

> Key invariant: **`eventId` is stored on the outbox row and reused on publish**,
> so the consumer sees the same identity no matter how many times the row was
> claimed.

## 2. Idempotent consumers (`consumer_dedup` table)

Migrations:
- `20260813000000_add_outbox_events` → `outbox_events` table
- `20260813010000_add_consumer_dedup` → `consumer_dedup` table (dropped the old
  orphan `processed_events` experiment table)

Table has a **unique index `(consumerId, eventId)`** — the lynchpin of dedup.

### Two idempotency strategies (read `idempotency.ts`)

**A. Transactional (analytics consumer)** — business effect + dedup commit together

```
markProcessedInTx(tx, ...)   // INSERT INTO consumer_dedup (consumerId,eventId,...)
    if P2002 (unique violation) → duplicate → return isDuplicate
jobAnalytics.upsert(...)      // effect only when mark is not duplicate
// both in the SAME prisma.$transaction → effect happens exactly once.
// If the effect fails, the tx rolls back AND the dedup insert rolls back too.
```

**B. Check-then-mark (mail + notification consumers)** — for external effects
(SMTP) that cannot be transactional with a DB write

```
if (await isAlreadyProcessed(consumerId, eventId)) → skip (deduped)
await sendWithRetry(...)        // SMTP
await markProcessed(...)        // write dedup row AFTER success
```

> Accepted trade-off (documented in the code): if the process crashes between
> "email sent" and "mark processed", the same email may be sent again on
> redelivery. That's **at-least-once**, deliberately chosen — no exactly-once
> claim. The window is tiny and the check-then-act makes the common duplicate
> (same event delivered twice in a row) free.

### Retention

`pruneProcessedRecords(prisma, retentionMs = 7 days)` deletes old dedup rows so
the table never grows unbounded.

## 3. Consumer-side retry classification (`dlq.ts`)

`isRetryableError(err)` — **default is NON-retryable** (an unclassified error is
probably a bug and should go to the DLQ):

| Retryable (TRUE) | Non-retryable (FALSE) |
|------------------|------------------------|
| `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` in message | everything else |
| Prisma `P1001/P1002/P1008/P2028/P2024` (connection/query failures) | programming bugs inside handler |
| `KafkaJSConnectionError`, `KafkaJSBrokerNotFound`, `KafkaJSNumberOfRetriesExceeded`, `KafkaJSRequestTimeout`, `KafkaJSTimeout` | malformed payload (parse errors are caught BEFORE the handler) |
| message contains `connection refused/connect timed out/timed out/timeout/temporarily unavailable/broker unavailable` | `NonRetryableError` (explicit) |

`runWithRetryAndDlq` (in `dlq.ts`) loops up to `maxAttempts` (default 3):
- success → done.
- retryable → `computeRetryDelayMs` (base 1000ms, `2^attempt`, cap 15000ms, ±jitter), `sleep`, try again.
- non-retryable OR attempts exhausted → `publishToDLQ` + return false.

`computeRetryDelayMs` (env `KAFKA_CONSUMER_RETRY_BASE_MS`/`KAFKA_CONSUMER_RETRY_MAX_MS`).

## 4. DLQ record format (`dlq.ts` → `publishToDLQ`)

Written to `send-mail-dlq` or `job-events-dlq`:

```json
{
  "v": 1,
  "envelope": { "eventId": "...", "eventType": "...", "payload": {...}, ... },  // original, unchanged
  "originalTopic": "send-mail",
  "partition": 0,
  "offset": "123",
  "consumerId": "mail-service",
  "error": "ECONNREFUSED ...",
  "attempts": 3,
  "reason": "max_attempts_reached" | "non_retryable_error",
  "failedAt": "2026-08-13T10:00:00.000Z"
}
```

> Preserving the **original envelope (incl. `eventId`)** is what makes replay
> idempotent-safe.

## 5. Replay (`packages/shared/src/kafka/replay.ts` + `scripts/kafka-replay.ts`)

`replayFromDlq`:
- uses a dedicated consumer **group `kafka-replay`** so live consumers' committed
  offsets are untouched.
- reads DLQ from the beginning, filters by `--consumer-id` / `--original-topic`.
- republishes the **same envelope** to the original topic (same `eventId`).
- **quiescence detection**: waits `quiesceMs` (default 3000ms) after the last
  message on an empty partition, or stops at `--limit`. (This replaced an earlier
  fixed 10 s deadline, so tests/CLI exit promptly.)

CLI usage:

```
pnpm kafka:replay --dlq-topic send-mail-dlq --consumer-id mail-service --limit 100
pnpm kafka:replay --dlq-topic job-events-dlq --original-topic job-events
```

Downstream live consumers receive the replayed event → their dedup guard decides:
- was never processed → now processed (recovery done)
- already processed → skipped (`recordDeduped`) → **no duplicate effect**

## 6. Correlation IDs (`correlation.ts`)

- `correlationMiddleware()` (Express) mints or adopts `x-correlation-id` per request.
- Stored in `AsyncLocalStorage` → any code in that request can read
  `getCorrelationId()`.
- Job service passes it to the outbox envelope; consumers run each message inside
  `runWithCorrelation(envelope.correlationId, ...)` so **consumer logs carry the
  same id as the originating HTTP request**.
- Also stamped as a Kafka **message header** on direct publishes.

Flow: `HTTP request` → request handler → outbox row → envelope → consumer →
handler logs → DLQ record. One id, end to end.

## 7. Metrics (`metrics.ts`)

In-process counters per clientId (no Prometheus/OTel by design):

| Counter | Bumped when |
|---------|-------------|
| `processed` | handler succeeded |
| `failed` | handler gave up (DLQ path) |
| `retries` | a retry is scheduled |
| `dlq` | message written to DLQ |
| `deduped` | duplicate eventId skipped |
| `totalProcessingMs` | accumulated handler duration |
| `outboxPending` / `outboxFailed` | set via `setOutboxCounts` (snapshot surface) |

Consumers log `eventId` + `correlationId` on every processed/retry/DLQ line —
structured observability without extra infrastructure.

## 8. Startup & shutdown orchestration (verified)

| Service | Boot (order) | Shutdown |
|---------|--------------|----------|
| **auth** | `ensureTopic("send-mail")` → `kafka.connect()` → `app.listen` | `kafka.disconnect()` on SIGTERM/SIGINT |
| **job** | `ensureTopic("send-mail")`, `ensureTopic("job-events")` → `kafka.connect()` → analytics consumer `.start()` → `startOutboxWorker().start()` → `app.listen` | analytics consumer stop + outbox worker stop |
| **utils** | `ensureTopic("send-mail"|"send-mail-dlq"|"job-events")` → mail consumer `.start()` → notification consumer `.start()` → `app.listen` | `Promise.all([mail.stop(), notif.stop()])` |

Consumer `.stop()` = `consumer.stop()` + `consumer.disconnect()` (KafkaJS),
triggering a clean group rebalance.

## 9. Verified guarantees

- **At-least-once, no exactly-once claim** — the docs and code never say
  exactly-once.
- **Ordering per partition** (message keys `job-<id>`/`applicant-<id>`), no
  global ordering.
- **No lost business events** — outbox row survives publish failure.
- **No duplicate business effects on redelivery/replay** — dedup by `eventId`.
- **Graceful startup/shutdown** maintained across all services.
- **Legacy messages** (pre-envelope) still parse via `normalizeKafkaMessage`.

Back to [`README.md`](README.md).