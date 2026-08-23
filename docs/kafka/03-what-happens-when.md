# 03 — What Happens When I Do X (every action traced through Kafka)

Each flow below assumes the services are running with Kafka reachable.

---

## Flow 1 — User registers / verifies email (auth service publishes `send-mail`)

**You do:** `POST /auth/register` (or request password reset).

**What happens:**

```mermaid
flowchart TB
    REG["register handler (auth/src/controllers/auth.ts:45)<br/>creates user + stores verify token in Redis"]
    PUB["kafka.publish('send-mail', { type: VERIFY_EMAIL, to, subject, html }<br/>correlationId: getCorrelationId())"]
    ENV["producer.wrapInEnvelope():<br/>eventId=uuid · eventType=VERIFY_EMAIL · source=auth-service"]
    SEND["producer.send() → topic send-mail (key: null)"]
    CONS["mail-service-group (utils)<br/>createConsumer pipeline"]
    NORM["normalizeKafkaMessage → EventEnvelope"]
    FILTER["shouldProcess: to + subject + html present? → yes"]
    H["handler (utils/src/consumer.ts)"]
    DEDUP["isAlreadyProcessed? no"]
    SMTP["mailDeliveryEnabled()?<br/>sendWithRetry SMTP — else preview-log"]
    MARK["markProcessed(consumer_dedup, eventId)"]
    LOG["metrics processed++ · log eventId + correlationId"]

    REG --> PUB --> ENV --> SEND --> CONS --> NORM --> FILTER --> H --> DEDUP --> SMTP --> MARK --> LOG
```

**Effect:** user gets "Verify Your Email" email.

---

## Flow 2 — User views a job (direct publish, fire-and-forget)

**You do:** `GET /api/jobs/:jobId` (a job detail view).

**What happens:**

```mermaid
flowchart TB
    GET["GET /api/jobs/:jobId<br/>jobs.controller.ts:547"]
    CACHE["redis cache read/write"]
    PUB["kafka.publish('job-events', { type: job.viewed, job_id, viewer_id, viewed_at }<br/>key: jobPartitionKey(job_id) · correlationId)"]
    ENV["wrapped in envelope · key = 'job-<jobId>' → one partition per job"]
    CATCH[".catch() logs failure but does NOT fail the HTTP response<br/>fire-and-forget"]
    CONS["job-analytics-group (job service)<br/>analytics consumer"]
    FILTER["shouldProcess: type === 'job.viewed'? → yes"]
    TX["transactional dedup: markProcessedInTx + prisma.$transaction"]
    UPSERT["jobAnalytics.upsert(job_id_date): views += 1"]

    GET --> CACHE --> PUB --> ENV --> CATCH --> CONS --> FILTER --> TX --> UPSERT
```

**Effect:** job's view counter increments for today (no HTTP delay from Kafka).

> notification-group sees `job.viewed` too but `shouldProcess` returns false
> (only `job.applied`) → skips.

---

## Flow 3 — User applies to a job (transactional outbox + fan-out)

**You do:** `POST /api/jobs/:jobId/applications` (apply).

**What happens:**

```mermaid
flowchart TB
    APP["POST /api/jobs/:jobId/applications (apply)<br/>applications.controller.ts:69"]
    subgraph TX["prisma.$transaction — ONE commit"]
        CR["tx.application.create(...)"]
        ENQ["enqueueOutboxEvent(tx, job.applied · topic=job-events<br/>partitionKey jobPartitionKey · correlationId)"]
        CR --> ENQ
    end
    NOTE["if publish later fails, the event is NEVER lost<br/>(still PENDING in outbox_events)"]

    subgraph WORKER["Outbox worker (jobservice/src/index.ts)"]
        POLL["poll OUTBOX_POLL_INTERVAL_MS<br/>claimOutboxBatch PENDING→PROCESSING"]
        PROC["processClaimed → kafka.publish<br/>key · eventId · correlationId"]
        SENT["success → SENT"]
        RT["retryable fail → PENDING + delay"]
        FAIL["max attempts → FAILED + lastError"]
        POLL --> PROC --> SENT
        PROC --> RT
        PROC --> FAIL
    end

    subgraph EVENT["Kafka topic job-events — broadcast to BOTH groups"]
        G1["job-analytics-group (job service)<br/>job.applied → jobAnalytics.upsert applications += 1"]
        G2["notification-group (utils)<br/>shouldProcess yes → handler<br/>lookup job → recruiter → applicant<br/>sendWithRetry recruiter email · markProcessed"]
        EVENT --> G1
        EVENT --> G2
    end

    APP --> TX --> NOTE --> WORKER --> EVENT
```

**Effect:** application saved; analytics count +1; recruiter gets "New Application"
email. Both happen because of ONE publish, in separate consumer groups.

---

## Flow 4 — Job status changes (outbox + two events)

**You do:** `POST/ PATCH` application `/api/applications/:id/status` (recruiter
changes status).

**What happens:**

```mermaid
flowchart TB
    ST["PATCH /api/applications/:id/status<br/>applications.controller.ts (applicationStatus handler)"]
    subgraph TX["prisma.$transaction"]
        UP["tx.application.update({ status })"]
        E1["enqueueOutboxEvent: application.status_mail<br/>topic=send-mail · applicantPartitionKey(id)<br/>payload {to, subject, html}"]
        E2["enqueueOutboxEvent: application.status_changed<br/>topic=job-events · jobPartitionKey(job_id)<br/>payload {type, job_id, new_status}"]
        UP --> E1
        UP --> E2
    end
    WORK["Outbox worker publishes both"]
    M["send-mail → mail-service-group<br/>applicant gets status-update email"]
    A["job-events → job-analytics-group<br/>status_changes += 1"]

    ST --> TX --> WORK --> M
    WORK --> A
```

**Effect:** applicant email + analytics status counter, both reliable.

---

## Flow 5 — A consumer fails (retry → DLQ → replay)

**Scenario:** SMTP is down, or a message is malformed, or the DB is unreachable.

```mermaid
flowchart TB
    CF["consumer-factory processMessage<br/>runWithRetryAndDlq"]
    H1["handler throws"]
    RET["isRetryableError?<br/>ECONNREFUSED/timeouts · Prisma P1001.. · KafkaJSConnectionError → TRUE<br/>anything else (bug, malformed, NonRetryableError) → FALSE"]
    RET2["retryable + attempts < max (default 3)"]
    BK["computeRetryDelayMs(attempt)<br/>exp backoff + jitter · metrics retries++<br/>log with eventId + correlationId<br/>sleep(delay) → try again"]
    GIVE["non-retryable OR exhausted"]
    DLQ["onGiveUp → metrics dlq++<br/>publishToDLQ(dlqTopic, DlqRecord{<br/>envelope (original eventId+correlationId) · originalTopic · partition<br/>offset · consumerId · error · attempts<br/>reason: non_retryable_error | max_attempts_reached })<br/>handler returns false → metrics failed++"]

    CF --> H1 --> RET
    RET -->|TRUE| RET2 --> BK --> H1
    RET2 -->|attempts exhausted| GIVE
    RET -->|FALSE| GIVE
    GIVE --> DLQ
    DLQ -.-> TOPIC["writes to send-mail-dlq / job-events-dlq"]
```

**To recover:** run the CLI

```
pnpm kafka:replay --dlq-topic send-mail-dlq --consumer-id mail-service --limit 100
```

```mermaid
flowchart TB
    RL["replay.ts: replayFromDlq<br/>consumer group 'kafka-replay' (never used by live consumers)"]
    READ["reads DLQ records<br/>filter by consumerId / originalTopic (optional)"]
    SEND["producer.send(originalTopic, envelope)<br/>SAME eventId reused"]
    AG["live consumer receives it again → isAlreadyProcessed?"]
    NO["HAD NOT processed (crashed before mark)<br/>→ processes now (recovery)"]
    YES["HAD processed (mark existed)<br/>→ dedup skips → NO double effect"]
    Q["quiescence: stops after quiesceMs idle or limit reached"]

    RL --> READ --> SEND --> AG --> NO
    AG --> YES
    SEND --> Q
```

**Effect:** failed persistent work is retried at a safe time; dedup prevents
double business effects.

---

## Flow 6 — Safe restart / graceful shutdown

**You do:** `SIGTERM` (docker stop / Ctrl+C).

```mermaid
flowchart TB
    SIG["SIGTERM / SIGINT"]

    A["auth service<br/>gracefulShutdown → kafka.disconnect()"]
    U["utils service<br/>Promise.all([mailConsumer.stop(), notificationConsumer.stop()])<br/>each stop → consumer.stop() + consumer.disconnect()"]
    J["job service<br/>analytics consumer stop + outbox worker stop"]

    SIG --> A
    SIG --> U
    SIG --> J

    U --> RB["group rebalances → other instances take over"]
    J --> SW["outbox rows stuck in PROCESSING<br/>caught by sweepStaleClaims after OUTBOX_PROCESSING_TIMEOUT_MS<br/>→ back to PENDING → another worker processes"]

    style SW fill:#fff3cd
```

- Consumers stop cleanly → group rebalances → other instances take over.
- Outbox rows in `PROCESSING` but never finished are caught by
  `sweepStaleClaims` (after `OUTBOX_PROCESSING_TIMEOUT_MS`) → back to `PENDING`
  → processed by another worker. No lost events.

---

## Flow 7 — Checking health / observability

- `GET /utils/health/ready` → consumers connected? 200 healthy / 503 degraded.
- `GET /auth/health/ready` → producer connected + broker count + topic list.
- `GET /<service>/health` → **liveness only** (process + uptime, always 200 while
  alive); readiness is the endpoint that reflects Kafka/DB health.
- Consumer logs contain `eventId` + `correlationId` on every processed/retry/DLQ
  line; metrics counters snapshot via `KafkaMetrics.snapshot()`.

Next: [`04-lifecycle-and-failures.md`](04-lifecycle-and-failures.md) for the
full pipeline detail (idempotency, retry/DLQ/replay, metrics).