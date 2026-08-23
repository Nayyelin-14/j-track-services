import { Kafka } from "kafkajs";
import { resolveKafkaConfig } from "./config";
import { isEnvelope } from "./envelope";
import type { EventEnvelope } from "./envelope";

export interface DlqMessage {
  v: number;
  envelope: EventEnvelope;
  originalTopic: string;
  partition: number;
  offset: string;
  consumerId: string;
  error: string;
  attempts: number;
  reason: string;
  failedAt: string;
}

export function parseDlqMessage(raw: string): DlqMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      isEnvelope(parsed.envelope) &&
      typeof parsed.originalTopic === "string" &&
      typeof parsed.consumerId === "string"
    ) {
      return parsed as DlqMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ReplayOptions {
  kafka: Kafka;
  dlqTopic: string;
  /** Replay only messages that failed for a specific consumer. */
  consumerId?: string;
  /** Replay only messages originally destined for a specific topic. */
  originalTopic?: string;
  /** How many messages to replay before pausing (0 = unlimited). */
  limit?: number;
  /** GroupId for the replay consumer; must differ from live consumers. */
  groupId?: string;
  /** How long to wait for quiescence after the last message (ms). */
  quiesceMs?: number;
  log?: (level: string, msg: string, meta?: Record<string, unknown>) => void;
  onReplayed?: (msg: DlqMessage) => void;
}

export interface ReplayResult {
  read: number;
  replayed: number;
  invalid: number;
  skipped: number;
}

/**
 * Replay dead-lettered messages back to their original topics. The original
 * envelope (including eventId and correlationId) is preserved verbatim, so
 * consumer-side idempotency sees the same eventId and duplicate effects are
 * prevented on replay.
 *
 * Consumption uses a dedicated group ("kafka-replay") that is never used by
 * live consumers, so replaying does not disturb their committed offsets.
 *
 * Quiescence detection: the process ends when no new message has arrived for
 * `quiesceMs` (default 3000ms) after the partition was drained, or when the
 * configured message limit is reached. This bounds the run in tests and in
 * bounded-replay CLI invocations.
 */
export async function replayFromDlq(options: ReplayOptions): Promise<ReplayResult> {
  const {
    kafka,
    dlqTopic,
    consumerId,
    originalTopic,
    limit = 0,
    groupId = "kafka-replay",
    quiesceMs = 3000,
    log = (l, m, meta) => console[l === "error" ? "error" : "log"](m, meta ?? {}),
    onReplayed,
  } = options;

  const consumer = kafka.consumer({ groupId });
  const producer = kafka.producer();

  const result: ReplayResult = { read: 0, replayed: 0, invalid: 0, skipped: 0 };

  let lastActivityAt = Date.now();
  let resolveDone: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topic: dlqTopic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      lastActivityAt = Date.now();

      if (limit > 0 && result.replayed >= limit) {
        resolveDone();
        return;
      }

      const raw = message.value?.toString();
      if (!raw) {
        result.invalid++;
        return;
      }

      const dlq = parseDlqMessage(raw);
      if (!dlq) {
        result.invalid++;
        log("warn", "Skipping malformed DLQ record", { topic: dlqTopic });
        return;
      }

      if (consumerId && dlq.consumerId !== consumerId) {
        result.skipped++;
        return;
      }
      if (originalTopic && dlq.originalTopic !== originalTopic) {
        result.skipped++;
        return;
      }

      await producer.send({
        topic: dlq.originalTopic,
        messages: [
          {
            key: message.key?.toString() ?? null,
            value: JSON.stringify(dlq.envelope),
            headers: dlq.envelope.correlationId
              ? { correlationId: dlq.envelope.correlationId }
              : undefined,
          },
        ],
      });

      result.replayed++;
      result.read++;
      onReplayed?.(dlq);
      log("info", "Replayed DLQ message", {
        originalTopic: dlq.originalTopic,
        eventId: dlq.envelope.eventId,
        correlationId: dlq.envelope.correlationId,
        consumerId: dlq.consumerId,
        reason: dlq.reason,
      });
    },
  });

  // Wait for quiescence (partition drained) or the message limit.
  const hardDeadline = Date.now() + 60_000;
  while (
    result.read === 0 &&
    !(limit > 0 && result.replayed >= limit) &&
    Date.now() < hardDeadline
  ) {
    if (Date.now() - lastActivityAt >= quiesceMs) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.race([finished, new Promise((r) => setTimeout(r, 500))]);

  await consumer.stop().catch(() => undefined);
  await consumer.disconnect().catch(() => undefined);
  await producer.disconnect().catch(() => undefined);
  return result;
}