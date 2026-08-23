# 06 — Interview Guide: "How I Built Kafka at j-track" (simple words)

> Purpose: a clear, honest story that shows the interviewer you understand Kafka
> **deeply** — not just that you "sent some messages."

---

## 0. The 30-second answer (use this first)

> "My backend is 4 small Node.js services: auth, user, job, utils. They needed to
> react to events without calling each other. For example, when someone applies
> to a job, I must (1) count it for analytics and (2) email the recruiter. So I
> made Kafka the message bus between services. I built it end-to-end: a safe way
> to publish (transactional outbox), a message wrapper with an `eventId`, smart
> consumers that never double-do work, retry with backoff, a dead-letter queue, a
> replay tool, and simple counters for monitoring. The key idea I stand by:
> delivery is **at-least-once**, and consumers are made 'idempotent' so
> redelivery never causes duplicate effects."

Why this works: you name the important words — outbox, eventId, idempotent,
DLQ, replay — instead of just "we used Kafka for messages."

---

## 1. Explain it in 4 simple steps (memorize this order)

### Step 1 — Why use Kafka
- Services don't need to know about each other. One service **produces**, others **consume**.
- **One event can feed many consumers.** When a user applies, one message can update analytics **and** email the recruiter. That is called **fan-out**.
- Events are saved in Kafka, so **work is not lost** when a service restarts.

### Step 2 — How I make publishing safe (the part that impresses)
- The problem: "I saved to the database, but sending to Kafka failed" = the event is lost.
- The fix: a **transactional outbox**. The business write and the "event to send" happen in the **same database transaction**:
  ```
  prisma.$transaction(async (tx) => {
    await tx.application.create(...)    // save the application
    await enqueueOutboxEvent(tx, {...}) // save a "to-send" row
  })
  // both save together, or both roll back together
  ```
- Then a worker picks up these "to-send" rows, publishes them, and marks them sent.
- If a worker dies, a "sweep" puts stuck rows back to pending, so they get sent later.
- Result: **no event is ever lost.**

### Step 3 — How I make receiving safe (at-least-once)
- Kafka may send the same message twice. So every message has an **`eventId`**.
- Consumers save processed `eventId`s to a `consumer_dedup` table. If the same `eventId` comes again, they skip it.
  - **For database work** (analytics): the dedup-save and the business update run in the **same transaction**. If the event comes twice, the second one is ignored. Effects happen exactly once.
  - **For emails (SMTP):** check dedup → send email → save dedup. If the app dies between "email sent" and "dedup saved," the email might be sent again. That's rare and I'm honest about it — it's the price of at-least-once.
- I **never say "exactly-once."** I say: at-least-once delivery + idempotent consumers.

### Step 4 — What I do when a consumer fails
- I sort errors into two kinds:
  - **Retryable** (temporary: network down, database busy) → retry with backoff.
  - **Not retryable** (a bug, a bad message) → send straight to the **DLQ** (dead-letter queue).
- The DLQ keeps the message with details: where it came from, why it failed, how many tries.
- A **replay CLI** re-sends DLQ messages to the original topic. Because the `eventId` is kept, consumers dedup correctly and nothing gets done twice.
- For tracking: every message has a **correlationId** — one id from the HTTP request all the way to the final log. Plus simple counters (processed, failed, retries, dlq) for quick monitoring.

---

## 2. Your best story: "A user applies for a job"

1. The request hits the job service.
2. In **one database transaction**: save the application + save an outbox row
   (`job.applied`, topic `job-events`, key `job-42`, correlationId).
3. The outbox worker publishes the event to `job-events`.
4. **Two groups** get it, independently:
   - **Analytics group** → count `applications +1` for that job, in the same
     transaction as the dedup save.
   - **Notification group** (utils) → find job → recruiter → applicant, email
     the recruiter, then save dedup.
5. If the email server is down: retry → then `job-events-dlq` → later replay →
     same `eventId` comes back → dedup says "already done" → skip.

Close with: "The HTTP request returns fast, both things still happen, and no
event is lost or done twice."

---

## 3. Quick answers (common interview questions)

**Q: How do you make sure messages aren't lost?**
> The "to-send" event is saved in the **same database transaction** as the
> business change. If publishing fails, the event is still in the DB and a
> worker sends it later. Nothing is lost.

**Q: Did you use exactly-once?**
> No. I use **at-least-once** delivery, and I make consumers **idempotent** with
> an eventId dedup table, so duplicates don't cause double effects. I don't
> claim exactly-once — that's a much stronger guarantee I can't honestly promise.

**Q: What if the same message is delivered twice?**
> The consumer checks the `eventId` in the dedup table. If it's there, it skips.
> For database work I even save the dedup marker in the same transaction as the
> work, so a duplicate literally cannot double-count.

**Q: How do you keep messages in order?**
> I give every message a **key** based on the thing it's about, like
> `job-42` or `applicant-7`. Kafka sends all messages with the same key to the
> same partition, so they arrive in order. I don't claim ordering across
> different partitions — only within one.

**Q: What if a consumer fails forever?**
> Temporary problems → retry with backoff. Permanent problems (bugs, bad data)
> → the message goes to the DLQ. The DLQ keeps it safely; I can inspect it and
> replay it later after fixing the cause.

**Q: Two consumers get the same event. Isn't that a problem?**
> No. Different **consumer groups** each get the event on purpose (fan-out) for
> different jobs — one for analytics, one for email. Inside one group, only one
> worker handles each message. And dedup handles replays.

**Q: How do you follow a message through the system?**
> Every message has a **correlationId** that starts with the HTTP request and
> stays on the same event in the log. So I can grep one id and see the whole
> journey. Counters give me the totals; the id gives me the story.

**Q: What would you do next?**
> Add a Schema Registry if messages change shape often; export counters to
> Prometheus when the system grows; tune how long dedup records are kept.

---

## 4. Be honest (interviewers respect this — say it yourself)

- "Delivery is at-least-once. I don't claim exactly-once."
- "With emails, a crash between send and dedup-save can rarely cause a re-send.
  I documented that trade-off instead of hiding it."
- "My monitoring is simple in-process counters. I'd add Prometheus when ops
  actually needs it — I don't add infrastructure for show."
- "Scaling here means adding more consumers to a group, which splits the
  partitions. I tested two consumers and saw no duplicate work. This is a small
  system — I won't invent fake load numbers."

---

## 5. One-line meanings for 14 Kafka words (rapid-fire practice)

| Word | Simple meaning |
|------|----------------|
| Topic | A named folder for events of one type |
| Partition | A slice of a topic; Kafka's unit of parallelism |
| Message key | A label that groups related messages into one partition (for ordering) |
| Consumer group | A team of consumers that split the partitions; each message handled once per team |
| Fan-out | Many teams reading the same topic at the same time |
| At-least-once | You may get a message more than once; consumers must handle that |
| Outbox | Save the event with the business change; publish it later, safely |
| Idempotent consumer | The same event twice → the effect still happens only once |
| Retry / backoff | Temporary failures are retried with longer waiting each time |
| DLQ | A topic for messages that failed; keeps them safe for later |
| Replay | Re-send DLQ messages to the original topic; same eventId → still safe |
| Correlation ID | One id that traces a request from start to final log |
| Rebalance | When a team member leaves, the partitions are split again among the rest |
| Envelope | The wrapper around a message that carries eventId, type, time, source, correlationId |

---

## 6. What to show live (no Kafka? show the tests)

1. Open [`README.md`](README.md) and the diagrams [`05-diagrams.md`](05-diagrams.md).
2. Run the shared tests — they fake Kafka and prove: outbox crash safety,
   duplicate handling, retry-then-DLQ, replay keeps eventId, partition keys,
   correlation id.
   ```
   pnpm --filter @jtrack/shared test   # 48 tests
   ```
3. Show the replay tool's help text:
   ```
   pnpm kafka:replay --help
   ```
4. If a real broker is running: open `/utils/health`, watch logs show
   `eventId` + `correlationId`.

---

Back to [`README.md`](README.md).