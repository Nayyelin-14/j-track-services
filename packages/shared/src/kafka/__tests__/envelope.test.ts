import { describe, it, expect } from "vitest";
import {
  wrapInEnvelope,
  normalizeKafkaMessage,
  isEnvelope,
  newEventId,
} from "../envelope.js";

describe("envelope: wrapInEnvelope", () => {
  it("wraps payload with all standard fields", () => {
    const envelope = wrapInEnvelope({
      eventType: "job.applied",
      eventVersion: 1,
      source: "job-service",
      payload: { type: "job.applied", job_id: 1 },
    });
    expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.eventType).toBe("job.applied");
    expect(envelope.eventVersion).toBe(1);
    expect(typeof envelope.occurredAt).toBe("string");
    expect(envelope.source).toBe("job-service");
    expect(envelope.payload).toEqual({ type: "job.applied", job_id: 1 });
  });

  it("preserves provided eventId and correlationId", () => {
    const id = newEventId();
    const envelope = wrapInEnvelope({
      eventId: id,
      eventType: "x",
      source: "s",
      correlationId: "corr-123",
      payload: {},
    });
    expect(envelope.eventId).toBe(id);
    expect(envelope.correlationId).toBe("corr-123");
  });
});

describe("envelope: isEnvelope / normalizeKafkaMessage", () => {
  it("recognizes envelope-shaped values", () => {
    expect(
      isEnvelope({ eventId: "a", eventType: "b", payload: {} }),
    ).toBe(true);
    expect(isEnvelope({ type: "legacy" })).toBe(false);
    expect(isEnvelope("nope")).toBe(false);
  });

  it("normalizes envelope-shaped raw JSON without modification", () => {
    const env = wrapInEnvelope({
      eventId: "stable-id",
      eventType: "job.applied",
      source: "job-service",
      correlationId: "corr-1",
      payload: { type: "job.applied" },
    });
    const parsed = normalizeKafkaMessage(JSON.stringify(env));
    expect(parsed.eventId).toBe("stable-id");
    expect(parsed.correlationId).toBe("corr-1");
  });

  it("wraps legacy non-envelope messages with a deterministic synthetic eventId", () => {
    const raw = JSON.stringify({ type: "job.applied", job_id: 42 });
    const a = normalizeKafkaMessage(raw);
    const b = normalizeKafkaMessage(raw);
    expect(a.eventId).toBe(b.eventId); // deterministic => dedupe-able
    expect(a.eventType).toBe("job.applied");
    expect(a.source).toBe("legacy");
    expect(a.payload).toEqual({ type: "job.applied", job_id: 42 });
  });

  it("throws on invalid JSON", () => {
    expect(() => normalizeKafkaMessage("not-json{")).toThrow(/valid JSON/);
  });
});