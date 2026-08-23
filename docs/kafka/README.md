# Kafka Guide — Where to Read Everything

> **Purpose of this folder**: a fast, ordered, copy-paste-friendly reference to
> read ALL Kafka code in j-track. Start here, follow the numbered files.

## Read these files in this order

| # | File | What it answers |
|---|------|-----------------|
| 1 | [`00-overview.md`](00-overview.md) | **30-second picture**: what Kafka does in this project, topics, groups, the full connection diagram |
| 2 | [`01-files-in-order.md`](01-files-in-order.md) | **All Kafka files listed** with a one-line job each, in the order you should read them (code first) |
| 3 | [`02-connections.md`](02-connections.md) | **Connection tables**: producer → topic → group → consumer → effect, message keys, env vars |
| 4 | [`03-what-happens-when.md`](03-what-happens-when.md) | **"What happens when I do X"**: every user action traced through Kafka, step by step |
| 5 | [`04-lifecycle-and-failures.md`](04-lifecycle-and-failures.md) | Startup/shutdown, retry, DLQ, replay, idempotency, metrics — the pipelines behind every message |
| 6 | [`05-diagrams.md`](05-diagrams.md) | **Real diagrams** (Mermaid + ASCII): overview, producer, fan-out, outbox state, consumer pipeline, retry→DLQ→replay, correlation, idempotency, ER model |
| 7 | [`06-interview-guide.md`](06-interview-guide.md) | **Interview guide**: 30s pitch, 4-layer explanation, walk-me-through story, Q&A answer cards, honesty points |

## 30-second summary

**Kafka = the async message bus.** Services do NOT call each other for
notifications/emails/analytics. Instead:

1. A **producer** publishes an **enveloped event** (with `eventId`,
   `correlationId`, partition key) to a **topic**.
2. Any number of **consumer groups** read the same topic; each group consumes
   every message **once per group**.
3. Each consumer is **idempotent** (dedup table `consumer_dedup`), **retries**
   transient failures, and sends permanent failures to a **DLQ**. A CLI replays
   the DLQ back to the original topic.

**Topics (4):** `job-events`, `send-mail`, `send-mail-dlq`, `job-events-dlq`

**Groups (3 live + 1 CLI):**

| Group | Service | Topic read | Effect |
|-------|---------|-----------|--------|
| `job-analytics-group` | job service | `job-events` | increments `job_analytics` (views/applications/status) |
| `notification-group` | utils service | `job-events` | emails recruiter on new application |
| `mail-service-group` | utils service | `send-mail` | sends SMTP emails (verify, reset, status) |
| `kafka-replay` | CLI (on demand) | a `*-dlq` topic | re-publishes DLQ messages to their original topic |

**Guarantee:** at-least-once delivery + idempotent consumers. Exactly-once is
NOT claimed.