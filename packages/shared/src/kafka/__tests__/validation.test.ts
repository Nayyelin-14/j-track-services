import { describe, it, expect } from "vitest";
import {
  validateEventEnvelope,
  EVENT_VALIDATORS,
} from "../validation.js";
import { wrapInEnvelope } from "../envelope.js";

function env(eventType: string, payload: unknown, eventVersion = 1) {
  return wrapInEnvelope({ eventId: "e", eventType, eventVersion, source: "s", payload });
}

describe("event validation: accepted shapes (v1)", () => {
  it("accepts a valid job.viewed", () => {
    expect(
      validateEventEnvelope(env("job.viewed", { type: "job.viewed", job_id: 42, viewed_at: "2026-08-13T00:00:00Z" })),
    ).toBeNull();
    expect(
      validateEventEnvelope(env("job.viewed", { type: "job.viewed", job_id: 42, viewer_id: 7, viewed_at: "2026-08-13T00:00:00Z" })),
    ).toBeNull();
  });

  it("accepts a valid job.applied", () => {
    expect(
      validateEventEnvelope(env("job.applied", { type: "job.applied", job_id: 1, applicant_id: 2, applied_at: "2026-08-13T00:00:00Z" })),
    ).toBeNull();
  });

  it("accepts a valid application.status_changed", () => {
    expect(
      validateEventEnvelope(env("application.status_changed", { type: "application.status_changed", job_id: 1, application_id: 3, new_status: "Hired", timestamp: "2026-08-13T00:00:00Z" })),
    ).toBeNull();
  });

  it("accepts valid mail payloads (VERIFY_EMAIL / RESET_PASSWORD / status_mail)", () => {
    const mail = { to: "a@b.c", subject: "Hi", html: "<p>hi</p>" };
    expect(validateEventEnvelope(env("VERIFY_EMAIL", mail))).toBeNull();
    expect(validateEventEnvelope(env("RESET_PASSWORD", { ...mail, from: "noreply@x.com" }))).toBeNull();
    expect(validateEventEnvelope(env("application.status_mail", mail))).toBeNull();
  });
});

describe("event validation: rejections are non-retryable reasons", () => {
  it("rejects unknown event types", () => {
    const r = validateEventEnvelope(env("mystery.event", {}));
    expect(r?.reason).toBe("unknown_event_type");
    expect(r?.detail).toContain("mystery.event");
  });

  it("rejects unsupported event versions", () => {
    const r = validateEventEnvelope(env("job.applied", { type: "job.applied", job_id: 1, applicant_id: 2, applied_at: "x" }, 999));
    expect(r?.reason).toBe("unsupported_version");
    expect(r?.detail).toContain("999");
  });

  it("rejects invalid payloads with the specific problems", () => {
    const r = validateEventEnvelope(env("job.applied", { type: "job.applied" }));
    expect(r?.reason).toBe("invalid_payload");
    expect(r?.detail).toContain("job_id");
    expect(r?.detail).toContain("applicant_id");
  });

  it("rejects non-object payloads", () => {
    const r = validateEventEnvelope(env("job.viewed", "not-an-object"));
    expect(r?.reason).toBe("invalid_payload");
    expect(r?.detail).toContain("object");
  });

  it("rejects a mail payload missing required fields", () => {
    const r = validateEventEnvelope(env("VERIFY_EMAIL", { to: "a@b.c" }));
    expect(r?.reason).toBe("invalid_payload");
    expect(r?.detail).toContain("subject");
    expect(r?.detail).toContain("html");
  });
});

describe("event validation: extensibility", () => {
  it("merges extra validators over the built-in registry", () => {
    const r = validateEventEnvelope(
      env("custom.event", {}),
      { "custom.event": { versions: [1], validate: () => ["nope"] } },
    );
    expect(r?.reason).toBe("invalid_payload");

    const ok = validateEventEnvelope(
      env("custom.event", {}),
      { "custom.event": { versions: [1], validate: () => [] } },
    );
    expect(ok).toBeNull();
  });

  it("registry contains the six event types the system produces today", () => {
    expect(Object.keys(EVENT_VALIDATORS).sort()).toEqual([
      "RESET_PASSWORD",
      "VERIFY_EMAIL",
      "application.status_changed",
      "application.status_mail",
      "job.applied",
      "job.viewed",
    ]);
  });
});