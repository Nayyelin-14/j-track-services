# Kafka Schema Evolution & Backward Compatibility (Phase 11)

This document explains how j-track's Kafka messages evolved from the original
"raw payload on the wire" format to the current envelope format, and how the
system tolerates both shapes on the same topic. The design goal is **zero-downtime
event streaming**: producers and consumers are upgraded independently, and old
(legacy) messages already sitting in a topic remain readable after the upgrade.

---

## 1. The two message shapes

### Legacy format (pre-envelope)
```json
{
  "type": "job.applied",
  "job_id": 42,
  "applicant_id": 7,
  "applied_at": "2026-08-13T10:00:00.000Z"
}
```
- No `eventId`, no `payload` wrapper, no envelope metadata.
- Could **not** be deduplicated — the same message redelivered had no identity.

### Envelope format (current)
```json
{
  "eventId": "21ca1ec7-dc77-479e-acd7-977f1c85bfd0",
  "eventType": "job.applied",
  "eventVersion": 1,
  "occurredAt": "2026-08-13T10:00:00.000Z",
  "source": "job-service",
  "correlationId": "87222b5e-7936-4053-a612-0b637cf7804f",
  "payload": {
    "type": "job.applied",
    "job_id": 42,
    "applicant_id": 7,
    "applied_at": "2026-08-13T10:00:00.000Z"
  }
}
```
- The original payload is preserved **verbatim** under `payload`, so all existing
  consumer logic that reads `job_id`, `type`, etc. keeps working unchanged.

---

## 2. How coexistence works

`normalizeKafkaMessage(raw)` in `packages/shared/src/kafka/envelope.ts:68` is the
single entry point every consumer uses (via the shared `createConsumer` factory):

1. Parse the raw value as JSON.
2. If it has the envelope shape (`eventId` string + `eventType` string + non-null
   `payload` object) → **use as-is**, preserving `eventId`/`correlationId`.
3. Otherwise → **wrap** the raw parsed value in a synthetic envelope:
   - `eventId` = deterministic SHA-256 hash (24 hex chars) of the raw string, so
     even a legacy message gets a stable identity that deduplication can use.
   - `eventType` = the legacy `type` field when present, else `"unknown"`.
   - `source` = `"legacy"`.
   - `payload` = the original parsed object.

Because the legacy body is always placed under `payload`, business handlers never
need to special-case old messages.

---

## 3. Event versioning

- Every envelope carries `eventVersion` (default `1`).
- Producers set it explicitly (e.g. outbox rows store `eventVersion`).
- `eventType` (e.g. `job.applied`) is the stable semantic name; `eventVersion`
  is the schema revision of its payload.
- A consumer that only understands `version 1` of `job.applied` should ignore or
  degrade on `version 2` payloads rather than parse them wrong. The shared
  helpers leave this policy to each handler (they receive the envelope and can
  branch on `eventVersion`).

---

## 4. Migration policy

| Concern | Rule |
|---------|------|
| Producers | All publish paths (`producer.publish`, outbox worker) now emit envelopes automatically. New code must not publish raw payloads. |
| Consumers | Deep-links go through `normalizeKafkaMessage`; they accept both shapes forever. |
| Rolling upgrade | Upgrade consumers first (they handle both formats), then flip producers to envelopes. No window where a consumer rejects new messages. |
| Historical data | Old messages already in `job-events` / `send-mail` remain processable and (via synthetic eventId) dedupe-able. |

### Python/Ruby-style strictness — why tolerant parsing?

Some ecosystems reject unknown fields or require a schema registry. j-track chose
**tolerant parsing** because:
- Topics are internal and have exactly three producers (job-service, auth-service).
- There is no external schema-registry contract to enforce.
- The cost of a bad parse is a malformed message going to the DLQ, which is
  handled; the cost of being strict is service-wide outage during upgrade.

---

## 5. Testing the guarantees

`packages/shared/src/kafka/__tests__/envelope.test.ts` covers:

- `normalizeKafkaMessage` passes envelope-shaped values through untouched
  (preserving `eventId`, `correlationId`).
- Legacy values are wrapped with a deterministic, stable synthetic `eventId`.
- Same legacy raw string → same synthetic `eventId` (dedupe-able on replay).
- Invalid JSON throws ParseError (consumer logs the error, never crashes).
- `wrapInEnvelope` defaults (`eventVersion` 1, `occurredAt` now, `source`).

---

## 6. Rolling this further

Future payload changes follow the same pattern:
1. Bump `eventVersion` on the producer.
2. Keep parsing both versions in consumers until old messages drain out of the
   (retention-bounded) topics, then drop the old shape.

No message-format flag or topic fork is required.