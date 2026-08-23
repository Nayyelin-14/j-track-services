import type { Kafka } from "kafkajs";
import type { EventEnvelope } from "./envelope";
import { sleep } from "./config";
import { isRetryablePublishError } from "./outbox";

export interface DlqRecord {
  envelope: EventEnvelope;
  originalTopic: string;
  partition: number;
  offset: bigint;
  consumerId: string;
  error: string;
  attempts: number;
  reason: string;
  failedAt: string;
  key?: string | null;
}

/**
 * Consumer-side retry classification. A retryable error is a transient
 * infrastructure or dependency failure (DB down, connection reset, 5xx) where
 * retrying soon has a real chance of success. Non-retryable errors are
 * permanent: malformed payload, missing required data, programming bugs inside
 * the handler. Retrying those wastes resources and delays healthy messages.
 *
 * Default is non-retryable: an unclassified error is most likely a bug, and
 * should go to the DLQ for inspection rather than be retried blindly.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const message = err.message ?? "";
  const name = err.name ?? "";
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(message)
  ) {
    return true;
  }
  if (
    /P1001|P1002|P1008|P2028|P2024/.test(name) || // Prisma connection/query failures
    /KafkaJSConnectionError|KafkaJSBrokerNotFound|KafkaJSNumberOfRetriesExceeded|KafkaJSRequestTimeout|KafkaJSTimeout/.test(name)
  ) {
    return true;
  }
  return /connection refused|connect timed out|timed out|timeout|temporarily unavailable|econnreset|broker unavailable/i.test(
    message,
  );
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export async function computeRetryDelayMs(attempt: number): Promise<number> {
  const base = Number(process.env["KAFKA_CONSUMER_RETRY_BASE_MS"]) || 1000;
  const max = Number(process.env["KAFKA_CONSUMER_RETRY_MAX_MS"]) || 15000;
  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

export interface RetryPolicy {
  maxAttempts: number;
  /** Return false to give up and go to DLQ on this error. */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run a consumer handler with bounded retries + exponential backoff + jitter.
 *
 * Returns:
 * - `true`  if the handler ultimately succeeded.
 * - `false` if the handler failed permanently AND the record was durably
 *   written to the DLQ.
 * - **throws** the original handler error if the DLQ write failed. The caller
 *   MUST treat this as "not durably handled": the consumer must not commit the
 *   offset so the message is redelivered on restart/rebalance.
 *
 * onGiveUp fires when the handler gives up (permanent failure). onDlqWritten
 * fires after the DLQ write succeeds.
 */
export async function runWithRetryAndDlq(params: {
  kafka: Kafka;
  dlqTopic: string;
  record: DlqRecord;
  handler: () => Promise<void>;
  policy?: RetryPolicy;
  onRetry?: (attempt: number, err: unknown) => void;
  onGiveUp?: () => void;
  onDlqWritten?: () => void;
  log?: (level: string, msg: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const maxAttempts = params.policy?.maxAttempts ?? 3;
  const isRetryable = params.policy?.isRetryable ?? isRetryableError;
  const log = params.log ?? defaultConsumerLog;
  const record = params.record;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await params.handler();
      return true;
    } catch (err) {
      const retryable = isRetryable(err);
      if (attempt < maxAttempts && retryable) {
        const delay = await computeRetryDelayMs(attempt);
        params.onRetry?.(attempt, err);
        log("warn", `retrying consumer handler (attempt ${attempt + 1}/${maxAttempts})`, {
          eventId: record.envelope.eventId,
          correlationId: record.envelope.correlationId,
          error: err instanceof Error ? err.message : String(err),
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }

      params.onGiveUp?.();
      const failure = await publishToDLQ(params.kafka, params.dlqTopic, {
        ...record,
        error: err instanceof Error ? err.message : String(err),
        attempts: attempt,
        reason: retryable ? `max_attempts_reached` : "non_retryable_error",
      });
      if (!failure) {
        log(
          "error",
          `publishToDLQ failed after retries; event NOT durably handled, offset must not be committed`,
          {
            eventId: record.envelope.eventId,
            correlationId: record.envelope.correlationId,
            dlqTopic: params.dlqTopic,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        // Surface the failure instead of swallowing it: KafkaJS will NOT
        // commit this offset, so the message is redelivered on restart.
        throw err;
      }
      params.onDlqWritten?.();
      return false;
    }
  }

  return false;
}

export function defaultConsumerLog(
  level: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const base = { ts: new Date().toISOString() };
  if (level === "error") console.error(msg, { ...base, ...meta });
  else if (level === "warn") console.warn(msg, { ...base, ...meta });
  else console.log(msg, { ...base, ...meta });
}

/**
 * Publish a dead-letter record to the DLQ topic. The record embeds the original
 * topic/partition/offset, eventId, consumer, error, attempts and the original
 * envelope (preserving eventId/correlationId for replay + idempotency).
 *
 * The write itself is retried (bounded) because a transient broker blip while
 * writing the DLQ must not silently lose the record. Returns true only when
 * the record reached the DLQ.
 */
export async function publishToDLQ(
  kafka: Kafka,
  topic: string,
  record: DlqRecord,
): Promise<boolean> {
  const producer = kafka.producer();
  const maxAttempts = Number(process.env["KAFKA_DLQ_PUBLISH_RETRIES"]) || 3;
  try {
    await producer.connect();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await producer.send({
          topic,
          messages: [
            {
              key: record.key ?? undefined,
              value: JSON.stringify({
                v: 1,
                envelope: record.envelope,
                originalTopic: record.originalTopic,
                partition: record.partition,
                offset: record.offset.toString(),
                consumerId: record.consumerId,
                error: record.error,
                attempts: record.attempts,
                reason: record.reason,
                failedAt: record.failedAt,
              }),
            },
          ],
        });
        return true;
      } catch (err) {
        const retryable = isRetryablePublishError(err);
        if (attempt < maxAttempts && retryable) {
          await sleep(await computeRetryDelayMs(attempt));
          continue;
        }
        console.error(
          `[DLQ] Failed to publish to ${topic}`,
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    }
    return false;
  } catch (err) {
    console.error(
      `[DLQ] Failed to connect and publish to ${topic}`,
      err instanceof Error ? err.message : err,
    );
    return false;
  } finally {
    await producer.disconnect().catch(() => undefined);
  }
}