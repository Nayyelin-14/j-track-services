# 05 — Kafka Diagrams

> Rendered diagrams (Mermaid) + copy-paste ASCII. GitHub renders the Mermaid
> blocks directly. Source of truth for every box: the files listed in
> [`01-files-in-order.md`](01-files-in-order.md).

---

## Diagram 1 — System overview (services → Kafka → consumers)

```mermaid
flowchart LR
    subgraph Producers
        AUTH["auth service :7000<br/>getKafkaProducer('auth-service')"]
        JOB["job service :7002<br/>outbox worker + direct publish"]
    end

    subgraph Kafka["Apache Kafka"]
        SM["topic: send-mail<br/><i>verify / reset / app status</i>"]
        JE["topic: job-events<br/><i>viewed / applied / status</i>"]
        DLQ1["send-mail-dlq"]
        DLQ2["job-events-dlq"]
    end

    subgraph Consumers
        MAIL["mail-service-group (utils :6001)<br/>SMTP"]
        AN["job-analytics-group (job :7002)<br/>job_analytics DB"]
        NOTIF["notification-group (utils :6001)<br/>recruiter email"]
        REPLAY["kafka-replay CLI<br/>remote replay"]
    end

    AUTH -->|publish VERIFY_EMAIL / RESET_PASSWORD| SM
    JOB -->|outbox: app status mail| SM
    JOB -->|outbox: job.applied, status_changed| JE
    JOB -->|direct: job.viewed| JE

    SM --> MAIL
    JE --> AN
    JE --> NOTIF

    MAIL -. failure .-> DLQ1
    AN -. failure .-> DLQ2
    NOTIF -. failure .-> DLQ2
    REPLAY -->|re-publish original envelope| SM
    REPLAY -->|re-publish original envelope| JE
    DLQ1 --> REPLAY
    DLQ2 --> REPLAY
```

---

## Diagram 2 — Producer internals (how a message is built & sent)

```mermaid
flowchart LR
    subgraph Business
        TX["prisma.$transaction<br/>create + enqueueOutboxEvent"]
        DIR["direct kafka.publish()"]
    end

    TX -->|PENDING row| OB["outbox_events table"]
    OB -->|claim batch| W["outbox worker<br/>claimOutboxBatch<br/>processClaimed"]
    W -->|SENT / FAILED| OB
    W -->|publish| ENV

    DIR --> ENV

    subgraph ENV["producer.ts"]
        E["wrapInEnvelope:<br/>eventId uuid · eventType<br/>occurredAt · source<br/>correlationId · payload"]
        P["producer.send:<br/>key = partition key<br/>headers = correlationId"]
    end

    E --> P
    P --> K["topic: job-events / send-mail"]
```

---

## Diagram 3 — Fan-out: ONE event, MULTIPLE groups

```mermaid
flowchart TB
    E["job.applied event<br/>eventId=fixed · key=job-42"]
    E --> P0["Kafka partition (keyed by job-42)"]
    P0 --> G1["consumer group job-analytics-group"]
    P0 --> G2["consumer group notification-group"]

    G1 --> A["job service — analytics consumer<br/>upsert job_analytics: applications +1"]
    G2 --> N["utils — notification consumer<br/>lookup job→recruiter→applicant<br/>email recruiter"]

    style G1 fill:#dbeafe
    style G2 fill:#dbeafe
```

**Rule:** each *group* gets every message. Within one group, partitions are
divided among its members — add an instance and it takes over partitions
(round-robin). One group never processes the same message twice.

---

## Diagram 4 — Outbox worker state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING : enqueueOutboxEvent (inside DB tx)
    PENDING --> PROCESSING : claimOutboxBatch (worker)
    PROCESSING --> SENT : kafka.publish ok
    PROCESSING --> PENDING : retryable error + attempts < max<br/>(availableAt = now + exp backoff)
    PROCESSING --> FAILED : attempts exhausted / non-retryable
    PROCESSING --> PENDING : sweepStaleClaims (timed-out claim)
    PENDING --> PROCESSING : (later worker poll)
    SENT --> [*]
    FAILED --> [*]
```

---

## Diagram 5 — Consumer pipeline (every consumer runs this)

```mermaid
sequenceDiagram
    actor K as Kafka
    participant CF as consumer-factory.ts
    participant EN as envelope.ts
    participant CO as correlation.ts
    participant DL as dlq.ts (retry)
    participant H as handler (business logic)
    participant MT as metrics.ts

    K->>CF: raw message value
    CF->>EN: normalizeKafkaMessage(raw)
    EN-->>CF: EventEnvelope (legacy-tolerant)
    CF->>CO: runWithCorrelation(correlationId)
    CF->>DL: runWithRetryAndDlq(handler)
    loop attempt=1..maxAttempts
        DL->>H: handler(envelope, partition, offset)
        alt success
            H-->>MT: recordProcessed(duration)
            H-->>CF: log eventId + correlationId
        else error & retryable & attempts<max
            DL-->>MT: recordRetry
            DL-->>H: sleep(exp backoff + jitter)
        else error & (not retryable OR exhausted)
            DL-->>MT: recordDlq
            DL-->>K: publishToDLQ(*-dlq topic)
        end
    end
```

---

## Diagram 6 — Failure → DLQ → Replay → Safe reprocessing

```mermaid
flowchart LR
    subgraph Live
        MSG["original event<br/>eventId = 9f3e..."]
        H1["mail consumer handler"]
    end

    MSG --> H1
    H1 --x|retry x3 then give up| DLQ["send-mail-dlq<br/>{envelope: eventId 9f3e...<br/>originalTopic, partition, offset,<br/>consumerId, error, reason}"]
    H1 -->|SMTP ok| OK["email sent"]
    DIFF["pnpm kafka:replay --dlq-topic send-mail-dlq"]

    DLQ --> DIFF
    DIFF -->|"re-publish SAME envelope (eventId 9f3e...)"| MSG

    MSG --> H1b["consumer again"]
    H1b -->|"idempotency: eventId already processed?<br/>yes → skip (recordDeduped)<br/>no → process (recovery)"| OUT["no duplicate effect"]
```

---

## Diagram 7 — Correlation ID end-to-end

```mermaid
sequenceDiagram
    participant Client
    participant MW as correlationMiddleware (Express)
    participant RT as route handler
    participant OB as outbox_events row
    participant ENV as Kafka envelope
    participant CONS as consumer (handler)
    participant LOG as logs

    Client->>MW: request (x-correlation-id: c-123)
    MW->>MW: AsyncLocalStorage.set(c-123)
    MW->>RT: next()
    RT->>OB: enqueueOutboxEvent(correlationId=c-123)
    OB->>ENV: envelope.correlationId=c-123
    ENV->>CONS: runWithCorrelation(c-123)
    CONS->>LOG: log "processed" {eventId, correlationId=c-123}
    Note over LOG: same id from HTTP request to final consumer log
```

---

## Diagram 8 — Idempotency strategies (two flavors)

```mermaid
flowchart TB
    E["event delivered (eventId X, consumerId Y)"] --> A{"consumer type?"}

    A -->|"analytics (DB effect)"| T1["markProcessedInTx(tx) — INSERT consumer_dedup (X,Y)"]
    T1 --> TD{"unique conflict P2002?"}
    TD -->|no| T2["jobAnalytics.upsert in SAME tx"]
    T2 --> T3["both commit atomically — effect once"]
    TD -->|yes| T4["skip — recordDeduped"]

    A -->|"mail/notification (SMTP effect)"| C1["isAlreadyProcessed(X,Y)?"]
    C1 -->|yes| C4["skip — recordDeduped"]
    C1 -->|no| C2["sendWithRetry SMTP"]
    C2 --> C3["markProcessed(X,Y) after success"]
    C3 --> C5["crash between C2 and C3?<br/>redelivery re-sends (at-least-once, accepted)"]
```

---

## Diagram 9 — Data model (new tables)

```mermaid
erDiagram
    OUTBOX_EVENTS {
        bigint id PK
        string eventId UK
        string eventType
        int eventVersion
        string topic
        string partitionKey
        string source
        string correlationId
        json payload
        enum status
        int attempts
        timestamp availableAt
        timestamp claimedAt
        string claimedBy
        timestamp processedAt
        string lastError
    }
    CONSUMER_DEDUP {
        bigint id PK
        string consumerId UK
        string eventId UK
        string eventType
        int partition
        bigint offset
        timestamp processedAt
        timestamp occurredAt
    }
```

`CONSUMER_DEDUP` unique index: `(consumerId, eventId)` — the dedup guarantee.

---

## ASCII fallback (no Mermaid renderer)

```
 AUTH ──► send-mail ──► mail-service-group ──► SMTP ──────────► ┬─► send-mail-dlq
 JOB  ──► job-events ──┬──► job-analytics-group ──► job_analytics DB
   (outbox + direct)   └──► notification-group ──► recruiter email ─► job-events-dlq
                                                            │
                        pnpm kafka:replay ◄── DLQ topics ─────┘
```

Back to [`README.md`](README.md).