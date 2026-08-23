# 02 — How Kafka Is Connected & Used (Connection Tables)

## Producers → Topics

| Producer | Call site | Topic | Event(s) | Delivery path |
|----------|-----------|-------|----------|---------------|
| **auth service** (`auth-service`) | `auth/src/controllers/auth.ts:56` | `send-mail` | verify email | direct `publish()` |
| **auth service** | `auth/src/controllers/auth.ts:450` | `send-mail` | password reset | direct `publish()` |
| **job service** (`job-service`) | `jobservice/src/controllers/jobs.controller.ts:547` | `job-events` | `job.viewed` | direct `publish()` (fire-and-forget) |
| **job service** | `jobservice/src/controllers/applications.controller.ts:80` | `job-events` | `job.applied` | outbox (transactional) |
| **job service** | `jobservice/src/controllers/applications.controller.ts:412` | `send-mail` | application status mail | outbox (transactional) |
| **job service** | `jobservice/src/controllers/applications.controller.ts:431` | `job-events` | `application.status_changed` | outbox (transactional) |

> **Direct publish** = the producer connects once and sends immediately.
> **Outbox** = write the event to `outbox_events` in the SAME DB transaction as
> the business write; a worker later claims it and publishes to Kafka. This makes
> "DB write + publish" atomic — no lost events if publish fails at that moment.

## Topics → Consumer groups (fan-out)

| Topic | Consumer group | Service | Effective when |
|-------|---------------|---------|----------------|
| `job-events` | `job-analytics-group` | job service | events with `type` = `job.viewed` / `job.applied` / `application.status_changed` |
| `job-events` | `notification-group` | utils service | events with `type` = `job.applied` only |
| `send-mail` | `mail-service-group` | utils service | payload has `to` + `subject` + `html` |
| `send-mail-dlq` | `kafka-replay` (CLI) | on demand | any DLQ record matching `--consumer-id/--original-topic` |
| `job-events-dlq` | `kafka-replay` (CLI) | on demand | same |

> **Fan-out**: because `job-events` is consumed by two DIFFERENT groups, the
> same `job.applied` message triggers BOTH analytics and recruiter notification.
> Within ONE group, only one instance processes any given message (round-robin
> across partitions).

## Consumer → what it does (side effects)

| Consumer | File | Reads | Dedup strategy | Effect | Failure → DLQ |
|----------|------|-------|----------------|--------|----------------|
| Analytics (`job-analytics`) | `jobservice/src/analytics/consumer.ts` | `job-events` | `markProcessedInTx` (transactional — dedup row + upsert commit together) | upsert `job_analytics` (views/applications/status_changes +1) | `job-events-dlq` |
| Notification (`notification-service`) | `utils/src/notification-consumer.ts` | `job-events` | `isAlreadyProcessed` → `markProcessed` (check-then-mark; SMTP can't be transactional) | lookup job→recruiter→applicant, email recruiter | `job-events-dlq` |
| Mail (`mail-service`) | `utils/src/consumer.ts` | `send-mail` | same check-then-mark | SMTP send via `sendWithRetry` | `send-mail-dlq` |

## Message keys (partitioning / ordering)

| Event | Key function | Key value | Why |
|-------|-------------|-----------|-----|
| `job.viewed`, `job.applied`, `application.status_changed` | `jobPartitionKey(jobId)` | `job-42` | all events for one job land in the same partition → processed in order |
| application status mail | `applicantPartitionKey(applicantId)` | `applicant-7` | order per applicant |
| auth `send-mail` | none (null key) | — | email ordering not required |

**Guarantee:** ordering holds **within a partition only**. No global ordering.

## Env vars that drive the wiring

See `packages/shared/src/kafka/config.ts` and `README.md`. The important ones:

| Var | Default | Effect |
|-----|---------|--------|
| `KAFKA_BROKER` | `localhost:9092` | cluster address (Comma-sep for many) |
| `KAFKA_SASL_*`, `KAFKA_SSL` | — | Confluent Cloud auth/TLS |
| `KAFKA_CONSUMER_GROUP` | `mail-service-group` | mail consumer group |
| `KAFKA_ANALYTICS_GROUP` | `job-analytics-group` | analytics group |
| `KAFKA_NOTIFICATION_GROUP` | `notification-group` | notification group |
| `KAFKA_JOB_EVENTS_TOPIC` | `job-events` | where job events go |
| `KAFKA_MAIL_TOPIC` / `KAFKA_DLQ_TOPIC` | `send-mail` / `send-mail-dlq` | mail + its DLQ |
| `KAFKA_ANALYTICS_DLQ_TOPIC` / `KAFKA_NOTIFICATION_DLQ_TOPIC` | `job-events-dlq` | job-event DLQ |
| `KAFKA_CONSUMER_MAX_ATTEMPTS` / `KAFKA_CONSUMER_RETRY_BASE_MS` / `..._MAX_MS` | 3 / 1000 / 15000 | consumer retry policy |
| `OUTBOX_*` (poll interval, batch, max attempts, sweep, retry) | — | outbox worker |
| `MAIL_SEND_ENABLED` / `MAIL_PREVIEW` / `NODE_ENV` | — | real SMTP vs preview log |

## The consumer pipeline (every consumer runs this)

```mermaid
flowchart TB
    MSG["Kafka message (raw value)"] --> CF["consumer-factory.createConsumer()"]
    CF -->|normalizeKafkaMessage(raw)| ENV["EventEnvelope (legacy-tolerant)"]
    ENV -->|shouldProcess(envelope)?| SKIP["skip if not our event type"]
    ENV -->|runWithCorrelation(correlationId)| RETRY["runWithRetryAndDlq (dlq.ts)"]
    RETRY --> H["handler(...)<br/>business logic (DB upsert or SMTP)"]

    H -->|success| MT["metrics: processed + duration<br/>log eventId + correlationId"]
    H -->|"error: isRetryableError?"| DEC{ }

    DEC -->|"yes & attempts < max"| R["exponential backoff + jitter,<br/>retry (metrics: retries++)"]
    R --> H
    DEC -->|"no / exhausted"| DLQ["publishToDLQ(dlqTopic)<br/>metrics: dlq++, failed++"]

    style DLQ fill:#f8d7da
```

## Health endpoints (how you see it's alive)

| Service | Endpoint | What it reports |
|---------|----------|-----------------|
| auth | `/health/ready` | Kafka producer `connected`, brokers count, topics, DB, Redis (200 healthy / 503 degraded) |
| utils | `/health/ready` | `mail` + `notification` consumers connected + lag (200 healthy / 503 degraded) |
| job | `/health/ready` | producer + analytics consumer health + lag (200 healthy / 503 degraded) |
| any | `/health` | **Liveness only** — process + uptime; always 200 while alive, so Kafka-down ≠ dead |

Next: [`03-what-happens-when.md`](03-what-happens-when.md) — trace every user action.