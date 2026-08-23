import type { EventEnvelope } from "./envelope";

/**
 * Lightweight runtime validation of Kafka event envelopes.
 *
 * Each known eventType declares the `eventVersion`s it supports and a
 * `validate(payload)` function returning a list of problems (empty = valid).
 * Consumers run `validateEventEnvelope` after normalization and BEFORE the
 * handler. Unknown event types, unsupported versions and invalid payloads are
 * treated as non-retryable and routed to the DLQ - retrying can never fix
 * them, and re-processing them wastes resources.
 *
 * Backward-compatible evolution rule: a new eventVersion must be ADDED to the
 * validator's `versions` array when its consumer is deployed, never removed.
 * Older versions remain supported.
 *
 * No Schema Registry is used: the schema surface is tiny (6 event types) and
 * the payloads are validated structurally by hand. Introduce a registry only
 * if the event catalogue grows large enough that drift becomes a real risk.
 */

export interface EventValidator {
  versions: number[];
  validate(payload: unknown): string[];
}

export interface ValidationFailure {
  reason: "unknown_event_type" | "unsupported_version" | "invalid_payload";
  detail: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isOptString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}
function isOptNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function validateJobViewed(payload: unknown): string[] {
  if (!isRecord(payload)) return ["payload must be an object"];
  const errs: string[] = [];
  if (payload.type !== "job.viewed") errs.push("type must be 'job.viewed'");
  if (!isNumber(payload.job_id)) errs.push("job_id must be a number");
  if (!isOptNumber(payload.viewer_id)) errs.push("viewer_id must be a number or undefined");
  if (!isString(payload.viewed_at)) errs.push("viewed_at must be a string");
  return errs;
}

function validateJobApplied(payload: unknown): string[] {
  if (!isRecord(payload)) return ["payload must be an object"];
  const errs: string[] = [];
  if (payload.type !== "job.applied") errs.push("type must be 'job.applied'");
  if (!isNumber(payload.job_id)) errs.push("job_id must be a number");
  if (!isNumber(payload.applicant_id)) errs.push("applicant_id must be a number");
  if (!isString(payload.applied_at)) errs.push("applied_at must be a string");
  return errs;
}

function validateApplicationStatusChanged(payload: unknown): string[] {
  if (!isRecord(payload)) return ["payload must be an object"];
  const errs: string[] = [];
  if (payload.type !== "application.status_changed")
    errs.push("type must be 'application.status_changed'");
  if (!isNumber(payload.job_id)) errs.push("job_id must be a number");
  if (!isNumber(payload.application_id)) errs.push("application_id must be a number");
  if (!isString(payload.new_status)) errs.push("new_status must be a string");
  if (!isString(payload.timestamp)) errs.push("timestamp must be a string");
  return errs;
}

function validateMail(payload: unknown): string[] {
  if (!isRecord(payload)) return ["payload must be an object"];
  const errs: string[] = [];
  if (!isString(payload.to)) errs.push("to must be a string");
  if (!isString(payload.subject)) errs.push("subject must be a string");
  if (!isString(payload.html)) errs.push("html must be a string");
  if (!isOptString(payload.from)) errs.push("from must be a string or undefined");
  return errs;
}

/** Built-in validators for every event this system produces today. */
export const EVENT_VALIDATORS: Record<string, EventValidator> = {
  "job.viewed": { versions: [1], validate: validateJobViewed },
  "job.applied": { versions: [1], validate: validateJobApplied },
  "application.status_changed": {
    versions: [1],
    validate: validateApplicationStatusChanged,
  },
  "VERIFY_EMAIL": { versions: [1], validate: validateMail },
  "RESET_PASSWORD": { versions: [1], validate: validateMail },
  "application.status_mail": { versions: [1], validate: validateMail },
};

/**
 * Validate an envelope's eventType / eventVersion / payload.
 * Returns a failure descriptor, or null when the event may be processed.
 * `extraValidators` lets a consumer add or override validators without
 * touching the shared registry.
 */
export function validateEventEnvelope(
  envelope: EventEnvelope,
  extraValidators: Record<string, EventValidator> = {},
): ValidationFailure | null {
  const validators = { ...EVENT_VALIDATORS, ...extraValidators };
  const spec = validators[envelope.eventType];
  if (!spec) {
    return {
      reason: "unknown_event_type",
      detail: `No validator for eventType '${envelope.eventType}'`,
    };
  }
  if (!spec.versions.includes(envelope.eventVersion)) {
    return {
      reason: "unsupported_version",
      detail: `eventVersion ${envelope.eventVersion} not supported for '${envelope.eventType}' (supported: ${spec.versions.join(", ")})`,
    };
  }
  const errors = spec.validate(envelope.payload);
  if (errors.length > 0) {
    return { reason: "invalid_payload", detail: errors.join("; ") };
  }
  return null;
}