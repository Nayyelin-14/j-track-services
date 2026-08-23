import { Kafka, Consumer } from "kafkajs";
import type { ConsumerInstance } from "./types";
import { resolveKafkaConfig } from "./config";
import { checkKafkaHealth, getConsumerLag } from "./consumer";
import {
  normalizeKafkaMessage,
  wrapInEnvelope,
} from "./envelope";
import type { EventEnvelope } from "./envelope";
import { runWithRetryAndDlq, publishToDLQ } from "./dlq";
import type { RetryPolicy } from "./dlq";
import { getMetrics } from "./metrics";
import { runWithCorrelation } from "./correlation";
import { validateEventEnvelope } from "./validation";
import type { EventValidator } from "./validation";

export interface ConsumerContext {
  envelope: EventEnvelope;
  consumerId: string;
  topic: string;
  partition: number;
  offset: bigint;
  kafka: Kafka;
  dlqTopic: string;
  log: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export interface CreateConsumerOptions {
  clientId: string;
  groupId: string;
  consumerId: string;
  topics: string[];
  handler: (ctx: ConsumerContext) => Promise<void>;
  /** Optional pre-filter. Return false to skip without dedup/DLQ. */
  shouldProcess?: (envelope: EventEnvelope) => boolean;
  /** Extra/overriding event validators, merged over the built-in registry. */
  validators?: Record<string, EventValidator>;
  maxAttempts?: number;
  isRetryable?: RetryPolicy["isRetryable"];
  dlqTopic?: string;
  fromBeginning?: boolean;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Injectable Kafka client. Used by tests to avoid a real broker; when
   * omitted, a client is built from env config via resolveKafkaConfig.
   */
  kafka?: Kafka;
}

/**
 * Shared consumer factory. Every consumer gets the same production-grade
 * pipeline, so behaviour is identical across services:
 *
 *   1. Normalize the raw value into an EventEnvelope (legacy-tolerant).
 *   2. Validate eventType / eventVersion / payload shape. Invalid events are
 *      NON-retryable and routed to the DLQ (they can never succeed on retry).
 *   3. Run the optional `shouldProcess` pre-filter (skips without dedup/DLQ).
 *   4. Run the handler inside the envelope's correlation context.
 *   5. On handler error: bounded retries with backoff, then DLQ.
 *   6. If the DLQ write itself fails, the error is RE-THROWN so KafkaJS does
 *      not commit the offset: the message is redelivered on restart rather
 *      than silently lost.
 *   7. Metrics (processed/failed/retries/dlq/dlqFailed/duration) per consumerId.
 *   8. Real consumer lag via broker offsets on healthCheck.
 *
 * Dedup is intentionally left to the handler (via idempotency helpers) because
 * the atomicity model differs between DB-transactional and external effects.
 */
export function createConsumer(options: CreateConsumerOptions): ConsumerInstance {
  const {
    clientId,
    groupId,
    consumerId,
    topics,
    handler,
    shouldProcess,
    maxAttempts,
    isRetryable,
    dlqTopic = "dlq",
    fromBeginning = false,
    kafka: injectedKafka,
    validators: extraValidators,
  } = options;

  const validators = { ...extraValidators };

  const log =
    options.log ??
    ((level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => {
      const ts = new Date().toISOString();
      if (level === "error") console.error(`[${consumerId}] ${msg}`, { ts, ...meta });
      else if (level === "warn") console.warn(`[${consumerId}] ${msg}`, { ts, ...meta });
      else console.log(`[${consumerId}] ${msg}`, { ts, ...meta });
    });

  const metrics = getMetrics(consumerId);

  let consumer: Consumer | null = null;
  let running = false;
  let kafka: Kafka | null = null;

  /**
   * Route an event that can never be processed (invalid JSON, failed
   * validation, throwing pre-filter) to the DLQ as non-retryable. Throws when
   * the DLQ write fails so the offset is not committed (redelivery on restart).
   */
  async function rejectToDlq(
    envelope: EventEnvelope,
    topic: string,
    partition: number,
    offset: string,
    reason: string,
    detail: string,
  ): Promise<void> {
    const ok = await publishToDLQ(kafka!, dlqTopic, {
      envelope,
      originalTopic: topic,
      partition,
      offset: BigInt(offset),
      consumerId,
      error: detail,
      attempts: 0,
      reason,
      failedAt: new Date().toISOString(),
      key: null,
    });
    if (!ok) {
      metrics.recordDlqFailed();
      log("error", "Could not write rejected event to DLQ; offset will NOT be committed", {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        reason,
        detail,
      });
      throw new Error(
        `DLQ write failed for rejected event ${envelope.eventId} (${reason}: ${detail})`,
      );
    }
    metrics.recordDlq();
    metrics.recordFailed();
  }

  async function processMessage(ctx: ConsumerContext): Promise<boolean> {
    const started = Date.now();
    try {
      const ok = await runWithRetryAndDlq({
        kafka: ctx.kafka,
        dlqTopic: ctx.dlqTopic,
        record: {
          envelope: ctx.envelope,
          originalTopic: ctx.topic,
          partition: ctx.partition,
          offset: ctx.offset,
          consumerId,
          error: "",
          attempts: 0,
          reason: "",
          failedAt: new Date().toISOString(),
          key: null,
        },
        handler: async () => {
          await handler(ctx);
        },
        policy: {
          maxAttempts:
            maxAttempts ??
            (Number(process.env["KAFKA_CONSUMER_MAX_ATTEMPTS"]) || 3),
          isRetryable,
        },
        onRetry: () => metrics.recordRetry(),
        onGiveUp: () => metrics.recordFailed(),
        onDlqWritten: () => metrics.recordDlq(),
        log: (level, msg, meta) => log(level as "info" | "warn" | "error", msg, meta),
      });

      if (ok) {
        metrics.recordProcessed(Date.now() - started);
        return true;
      }
      return false;
    } catch (err) {
      // Handler failed permanently AND the DLQ write failed. The error was
      // re-thrown so the offset is not committed; log loudly for operators.
      metrics.recordDlqFailed();
      log("error", "Handler failed and DLQ write failed; offset will NOT be committed", {
        eventId: ctx.envelope.eventId,
        correlationId: ctx.envelope.correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return {
    async start() {
      if (running) return;
      kafka = injectedKafka ?? new Kafka(resolveKafkaConfig(clientId));
      consumer = kafka.consumer({ groupId });
      await consumer.connect();
      await Promise.all(
        topics.map((topic) =>
          consumer!.subscribe({ topic, fromBeginning }),
        ),
      );
      running = true;
      log("info", `Started, listening on ${topics.join(", ")}`);

      // The authoritative dead-consumer signal. KafkaJS reports crashes via the
      // consumer.crash instrumentation event; `consumer.run()` itself resolves
      // early (runner.start() never throws - errors go to the internal onCrash
      // handler), so a try/catch around consumer.run() will NOT observe a
      // message-handler crash. Only this event tells us the consumer really
      // stopped:
      //   - restart === false  -> permanent stop (e.g. a DLQ write failed and
      //     we rethrew). No auto-restart; mark not running so readiness
      //     reports degraded and operators know to restart the service.
      //   - restart === true   -> transient crash; KafkaJS will restart it
      //     itself, keep reporting running (readiness already degrades via the
      //     healthCheck broker probe while the broker is unreachable).
      const onCrash = (event: { payload?: { restart?: boolean; error?: Error } }) => {
        if (event.payload?.restart === false) {
          running = false;
          log(
            "error",
            "Consumer crashed permanently (non-retriable); will NOT auto-restart. Restart the service to resume from the last committed offset.",
            {
              error: event.payload.error?.message ?? "unknown",
            },
          );
        } else {
          log("warn", "Consumer crash; KafkaJS will auto-restart", {
            error: event.payload?.error?.message ?? "unknown",
          });
        }
      };
      if (typeof consumer!.on === "function" && consumer!.events?.CRASH) {
        consumer!.on(consumer!.events.CRASH, onCrash);
      }

      try {
        await consumer.run({
          // KafkaJS default: one message at a time per partition, partitions
          // processed concurrently. Per-partition ordering is preserved; a
          // global concurrency limiter is intentionally NOT added because it
          // would risk reordering per-aggregate messages.
          eachMessage: async ({ topic, partition, message }) => {
            const rawValue = message.value?.toString();
            if (!rawValue) {
              log("warn", "Received empty message, skipping");
              return;
            }

            let envelope: EventEnvelope;
            try {
              envelope = normalizeKafkaMessage(rawValue);
            } catch (err) {
              // Unparseable JSON can never succeed; DLQ it for inspection.
              log("error", "Invalid JSON message; routing to DLQ", {
                error: err instanceof Error ? err.message : String(err),
              });
              const synthetic = wrapInEnvelope({
                eventType: "unknown",
                source: "legacy",
                payload: { raw: rawValue },
              });
              await rejectToDlq(
                synthetic,
                topic,
                partition,
                message.offset,
                "invalid_json",
                "Kafka message is not valid JSON",
              );
              return;
            }

            // Validate eventType/eventVersion/payload BEFORE the handler.
            // Invalid events are non-retryable and go to the DLQ.
            const invalid = validateEventEnvelope(envelope, validators);
            if (invalid) {
              log("warn", "Event failed validation; routing to DLQ", {
                eventId: envelope.eventId,
                eventType: envelope.eventType,
                eventVersion: envelope.eventVersion,
                reason: invalid.reason,
                detail: invalid.detail,
              });
              await rejectToDlq(
                envelope,
                topic,
                partition,
                message.offset,
                invalid.reason,
                invalid.detail,
              );
              return;
            }

            if (shouldProcess) {
              let process: boolean;
              try {
                process = shouldProcess(envelope);
              } catch (err) {
                // A throwing pre-filter is a bug in the consumer; treat the
                // event as poison and DLQ it instead of crashing the loop.
                log("error", "shouldProcess threw; routing to DLQ", {
                  eventId: envelope.eventId,
                  error: err instanceof Error ? err.message : String(err),
                });
                await rejectToDlq(
                  envelope,
                  topic,
                  partition,
                  message.offset,
                  "invalid_payload",
                  `shouldProcess threw: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
              }
              if (!process) {
                return;
              }
            }

            await runWithCorrelation(envelope.correlationId, () =>
              processMessage({
                envelope,
                consumerId,
                topic,
                partition,
                offset: BigInt(message.offset),
                kafka: kafka!,
                dlqTopic,
                log,
              }),
            );
          },
        });
      } catch (err) {
        // Fallback guard. KafkaJS routes handler crashes to its internal
        // onCrash (observed via consumer.crash above); this catch is for any
        // remaining synchronous run() failure. Either way: mark stopped, DO
        // NOT kill the process - the service keeps serving traffic and
        // readiness reports degraded until restart.
        running = false;
        log("error", "Consumer run loop terminated; restarting the service to resume from the last committed offset", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async stop() {
      if (!running || !consumer) return;
      running = false;
      log("info", "Stopping...");
      await consumer.stop();
      await consumer.disconnect();
      consumer = null;
      log("info", "Stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async healthCheck() {
      const health = await checkKafkaHealth(clientId, consumer !== null && running);
      if (health.connected) {
        const lag = await getConsumerLag(clientId, groupId, topics);
        if (lag) {
          health.lag = lag;
        }
      }
      return health;
    },
  };
}