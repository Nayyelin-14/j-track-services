# 01 — All Kafka Files, in the Order to Read Them

> This is the complete list of every file that was created or modified for the
> Kafka feature. Read them top-to-bottom in **Phase order** (foundation → shared
> pipeline → producer wiring → consumers → CLI → tests → docs).

## Part A — Shared library (foundation) `packages/shared/src/kafka/`

| Order | File | One-line job | Created/Modified |
|-------|------|--------------|------------------|
| 1 | [`config.ts`](../../packages/shared/src/kafka/config.ts) | Reads env vars → Kafka client config (broker, SASL/SSL, timeouts, retries) | edited |
| 2 | [`types.ts`](../../packages/shared/src/kafka/types.ts) | Core interfaces: `ProducerInstance`, `ConsumerInstance`, `PublishOptions`, `MailMessage` | edited |
| 3 | [`events.ts`](../../packages/shared/src/kafka/events.ts) | Typed job event payloads (`job.viewed`, `job.applied`, `application.status_changed`) | edited |
| 4 | [`envelope.ts`](../../packages/shared/src/kafka/envelope.ts) | The `EventEnvelope` type + `wrapInEnvelope` + `normalizeKafkaMessage` (legacy-tolerant) | **new** |
| 5 | [`partitioning.ts`](../../packages/shared/src/kafka/partitioning.ts) | Message-key derivation: `jobPartitionKey`, `applicantPartitionKey` (ordering per aggregate) | **new** |
| 6 | [`producer.ts`](../../packages/shared/src/kafka/producer.ts) | Singleton `getKafkaProducer(clientId)`; auto-wraps every message in an envelope; idempotent producer | edited |
| 7 | [`outbox.ts`](../../packages/shared/src/kafka/outbox.ts) | **Transactional outbox**: enqueue in DB tx, claim batch, process → publish, sweep stale, worker loop | **new** |
| 8 | [`idempotency.ts`](../../packages/shared/src/kafka/idempotency.ts) | `consumer_dedup` read/write: `markProcessed`, `markProcessedInTx`, `isAlreadyProcessed`, `pruneProcessedRecords` | **new** |
| 9 | [`dlq.ts`](../../packages/shared/src/kafka/dlq.ts) | `isRetryableError` classification + `runWithRetryAndDlq` + `publishToDLQ` | **new** |
| 10 | [`replay.ts`](../../packages/shared/src/kafka/replay.ts) | `replayFromDlq`: read DLQ topic, re-publish to original topic, quiescence-based | **new** |
| 11 | [`metrics.ts`](../../packages/shared/src/kafka/metrics.ts) | In-process counters: processed/failed/retries/dlq/deduped/outbox + snapshot | **new** |
| 12 | [`correlation.ts`](../../packages/shared/src/kafka/correlation.ts) | `correlationId` via `AsyncLocalStorage`; Express middleware `correlationMiddleware` | **new** |
| 13 | [`consumer-factory.ts`](../../packages/shared/src/kafka/consumer-factory.ts) | `createConsumer()`: normalize → correlation ctx → retry+Dlq → metrics. **The pipeline every consumer uses** | **new** |
| 14 | [`consumer.ts`](../../packages/shared/src/kafka/consumer.ts) | `checkKafkaHealth` utility (used by health endpoints) | edited |
| 15 | [`topic.ts`](../../packages/shared/src/kafka/topic.ts) | `ensureTopic` (auto-create missing topics), `listTopics`, `deleteTopic` | edited |

## Part B — Where it is wired into services

| Order | File | One-line job |
|-------|------|--------------|
| 16 | [`services/auth/src/kafka.ts`](../../services/auth/src/kafka.ts) | auth's singleton producer: `getKafkaProducer("auth-service")` |
| 17 | [`services/auth/src/controllers/auth.ts`](../../services/auth/src/controllers/auth.ts) | auth publishes `send-mail` (verify email @56, reset password @450) |
| 18 | [`services/auth/src/index.ts`](../../services/auth/src/index.ts) | auth boots Kafka: `ensureTopic("send-mail")`, `kafka.connect()`, graceful shutdown, health |
| 19 | [`services/jobservice/src/controllers/applications.controller.ts`](../../services/jobservice/src/controllers/applications.controller.ts) | job service ENQUEUES outbox events: `job.applied` (@80), `application.status_mail` (@412), `application.status_changed` (@431) |
| 20 | [`services/jobservice/src/controllers/jobs.controller.ts`](../../services/jobservice/src/controllers/jobs.controller.ts) | direct `publish("job-events", job.viewed)` (@547, fire-and-forget analytics) |
| 21 | [`services/jobservice/src/index.ts`](../../services/jobservice/src/index.ts) | job service boots: analytics consumer + outbox worker (`startOutboxWorker`) |
| 22 | [`services/jobservice/src/analytics/consumer.ts`](../../services/jobservice/src/analytics/consumer.ts) | **analytics consumer** (`job-analytics-group`): upserts `job_analytics` transactionally with dedup |
| 23 | [`services/utils/src/index.ts`](../../services/utils/src/index.ts) | utils boots: `ensureTopic` x3, starts BOTH consumers, graceful shutdown, health |
| 24 | [`services/utils/src/consumer.ts`](../../services/utils/src/consumer.ts) | **mail consumer** (`mail-service-group`): validates payload, SMTP send, dedup check-then-mark |
| 25 | [`services/utils/src/notification-consumer.ts`](../../services/utils/src/notification-consumer.ts) | **notification consumer** (`notification-group`): only `job.applied` → find job/recruiter/applicant → email recruiter |
| 26 | [`services/utils/src/mail.ts`](../../services/utils/src/mail.ts) | SMTP transporter + `sendWithRetry` + `mailDeliveryEnabled` (preview/production toggle) |
| 27 | [`scripts/kafka-replay.ts`](../../scripts/kafka-replay.ts) | **CLI**: `pnpm kafka:replay --dlq-topic ... [--consumer-id] [--limit]` |

## Part C — DB migrations & schema

| Order | File | One-line job |
|-------|------|--------------|
| 28 | [`prisma/migrations/20260813000000_add_outbox_events/`](../../packages/shared/prisma/migrations/20260813000000_add_outbox_events/migration.sql) | Creates `outbox_events` table + `outbox_status` enum |
| 29 | [`prisma/migrations/20260813010000_add_consumer_dedup/`](../../packages/shared/prisma/migrations/20260813010000_add_consumer_dedup/migration.sql) | Drops orphan `processed_events`, creates `consumer_dedup` |
| 30 | [`prisma/schema.prisma`](../../packages/shared/prisma/schema.prisma) | `OutboxEvent` + `ConsumerDedup` Prisma models |

## Part D — Tests (full pipeline coverage)

| Order | File | What it proves |
|-------|------|----------------|
| 31 | [`__tests__/envelope.test.ts`](../../packages/shared/src/kafka/__tests__/envelope.test.ts) | normalize passes envelopes through; legacy wrapped with stable synthetic eventId; invalid JSON throws |
| 32 | [`__tests__/outbox.test.ts`](../../packages/shared/src/kafka/__tests__/outbox.test.ts) | enqueue/claim/process/sweep; crash paths; no double-publish on sweep |
| 33 | [`__tests__/idempotency.test.ts`](../../packages/shared/src/kafka/__tests__/idempotency.test.ts) | dedup insert/duplicate/prune with fake prisma |
| 34 | [`__tests__/dlq-replay.test.ts`](../../packages/shared/src/kafka/__tests__/dlq-replay.test.ts) | retry then DLQ; non-retryable → straight to DLQ; replay preserves eventId |
| 35 | [`__tests__/partitioning.test.ts`](../../packages/shared/src/kafka/__tests__/partitioning.test.ts) | key derivation `job-<id>`, `applicant-<id>` |
| 36 | [`__tests__/correlation.test.ts`](../../packages/shared/src/kafka/__tests__/correlation.test.ts) | ALS context propagates corr id; middleware mints/adopts |
| 37 | [`__tests__/metrics.test.ts`](../../packages/shared/src/kafka/__tests__/metrics.test.ts) | counter snapshot + singleton registry |
| 38 | [`__tests__/consumer-factory.test.ts`](../../packages/shared/src/kafka/__tests__/consumer-factory.test.ts) | the full createConsumer pipeline against a fake Kafka |
| — | service tests | auth 32, jobservice 28, user 19, utils 43 (include kafka paths) |

## Part E — Docs

| Order | File | What it explains |
|-------|------|------------------|
| 39 | `docs/kafka/README.md` (this folder) | reading order + quick tables |
| 40 | `docs/kafka-architecture.md` | the full architecture guide (Phase 14) |
| 41 | `docs/kafka-schema-evolution.md` | envelope vs legacy format, compatibility (Phase 11) |

## Recommended reading path (if you want depth)

1. `envelope.ts` → `partitioning.ts` → `producer.ts` (how messages are built + sent)
2. `outbox.ts` (how job service publishes reliably)
3. `idempotency.ts` → `dlq.ts` → `consumer-factory.ts` (the consumer side pipeline)
4. `correlation.ts` → `metrics.ts` (observability)
5. `replay.ts` + `scripts/kafka-replay.ts` (operations)
6. One consumer each: `analytics/consumer.ts`, `consumer.ts` (mail), `notification-consumer.ts`
7. Tests in order 31–38 to see the guarantees proven.

Next: [`02-connections.md`](02-connections.md) for the connection tables.