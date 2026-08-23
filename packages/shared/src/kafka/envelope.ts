import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  source: string;
  correlationId?: string;
  payload: TPayload;
}

export interface EnvelopeInput<TPayload> {
  eventId?: string;
  eventType?: string;
  eventVersion?: number;
  occurredAt?: string;
  source: string;
  correlationId?: string;
  payload: TPayload;
}

export function newEventId(): string {
  return randomUUID();
}

export function wrapInEnvelope<TPayload>(
  input: EnvelopeInput<TPayload>,
): EventEnvelope<TPayload> {
  return {
    eventId: input.eventId ?? newEventId(),
    eventType: input.eventType ?? "",
    eventVersion: input.eventVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source,
    correlationId: input.correlationId,
    payload: input.payload,
  };
}

/**
 * True when a parsed Kafka value was produced by this system's envelope.
 * Legacy pre-envelope messages lack the `eventId`/`payload` envelope fields.
 */
export function isEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["eventId"] === "string" &&
    typeof v["eventType"] === "string" &&
    typeof v["payload"] === "object" &&
    v["payload"] !== null
  );
}

export interface NormalizedMessage {
  envelope: EventEnvelope;
}

/**
 * Parse a raw Kafka message value.
 * - Envelope-shaped values are used as-is (preserving eventId/correlationId).
 * - Legacy values are wrapped in a synthetic envelope. The synthetic eventId is
 *   a deterministic hash of the raw value so even old messages can be deduped.
 * Throws ParseError when the value is not valid JSON.
 */
export function normalizeKafkaMessage(raw: string): EventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Kafka message is not valid JSON: ${raw.slice(0, 120)}`);
  }

  if (isEnvelope(parsed)) {
    return parsed;
  }

  const syntheticEventId = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return wrapInEnvelope({
    eventId: syntheticEventId,
    eventType:
      typeof (parsed as Record<string, unknown>)["type"] === "string"
        ? ((parsed as Record<string, unknown>)["type"] as string)
        : "unknown",
    source: "legacy",
    payload: parsed,
  });
}

export function extractEventId(envelope: EventEnvelope): string {
  return envelope.eventId;
}

export function extractCorrelationId(envelope: EventEnvelope): string | undefined {
  return envelope.correlationId;
}