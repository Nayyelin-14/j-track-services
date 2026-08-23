import { randomUUID } from "node:crypto";
import type { OutboxEvent, Prisma, PrismaClient } from "@prisma/client";
import type { ProducerInstance } from "./types";
import { sleep } from "./config";
import { runWithCorrelation } from "./correlation";

export interface OutboxEnqueueInput {
  eventId?: string;
  eventType: string;
  eventVersion?: number;
  topic: string;
  partitionKey?: string | null;
  source: string;
  correlationId?: string | null;
  payload: Prisma.InputJsonValue;
}

export interface OutboxWorkerOptions {
  prisma: PrismaClient;
  kafka?: ProducerInstance;
  workerId: string;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  processingTimeoutMs?: number;
  sweepIntervalMs?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface OutboxWorker {
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<number>;
  processOnce(): Promise<number>;
}

const defaults = {
  pollIntervalMs: () => Number(process.env["OUTBOX_POLL_INTERVAL_MS"]) || 1000,
  batchSize: () => Number(process.env["OUTBOX_BATCH_SIZE"]) || 10,
  maxAttempts: () => Number(process.env["OUTBOX_MAX_ATTEMPTS"]) || 5,
  processingTimeoutMs: () =>
    Number(process.env["OUTBOX_PROCESSING_TIMEOUT_MS"]) || 30000,
  sweepIntervalMs: () =>
    Number(process.env["OUTBOX_SWEEP_INTERVAL_MS"]) || 15000,
  retryBaseMs: () => Number(process.env["OUTBOX_RETRY_BASE_MS"]) || 1000,
  retryMaxMs: () => Number(process.env["OUTBOX_RETRY_MAX_MS"]) || 60000,
};

export function newEventId(): string {
  return randomUUID();
}

export async function enqueueOutboxEvent(
  tx: Prisma.TransactionClient,
  input: OutboxEnqueueInput,
): Promise<OutboxEvent> {
  return tx.outboxEvent.create({
    data: {
      eventId: input.eventId ?? newEventId(),
      eventType: input.eventType,
      eventVersion: input.eventVersion ?? 1,
      topic: input.topic,
      partitionKey: input.partitionKey ?? null,
      source: input.source,
      correlationId: input.correlationId ?? null,
      payload: input.payload,
      status: "PENDING",
      availableAt: new Date(),
    },
  });
}

function coercePayload(blob: unknown): Record<string, unknown> {
  if (typeof blob === "string") {
    return JSON.parse(blob) as Record<string, unknown>;
  }
  if (blob && typeof blob === "object") {
    return blob as Record<string, unknown>;
  }
  throw new Error("Outbox payload is not a JSON object");
}

export function isRetryablePublishError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { retriable?: boolean };
  if (typeof e.retriable === "boolean") return e.retriable;
  if (e.name === "KafkaJSNonRetriableError") return false;
  if (
    /KafkaJS(ConnectionError|Timeout|BrokerNotAvailable|NumberOfRetriesExceeded|RequestTimeout)/.test(
      e.name,
    )
  ) {
    return true;
  }
  return /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/.test(
    e.message ?? "",
  );
}

export function retryDelayMs(attempt: number): number {
  const base = defaults.retryBaseMs();
  const max = defaults.retryMaxMs();
  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

export async function claimOutboxBatch(
  prisma: PrismaClient,
  workerId: string,
  batchSize?: number,
): Promise<OutboxEvent[]> {
  const size = batchSize ?? defaults.batchSize();
  const now = new Date();

  const candidates = await prisma.outboxEvent.findMany({
    where: { status: "PENDING", availableAt: { lte: now } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: size,
  });

  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((c) => c.id);

  return prisma.$transaction(async (tx) => {
    const result = await tx.outboxEvent.updateMany({
      where: { id: { in: candidateIds }, status: "PENDING" },
      data: {
        status: "PROCESSING",
        claimedAt: now,
        claimedBy: workerId,
        attempts: { increment: 1 },
      },
    });

    if (result.count === 0) return [];

    return tx.outboxEvent.findMany({
      where: {
        id: { in: candidateIds },
        status: "PROCESSING",
        claimedBy: workerId,
      },
      orderBy: { createdAt: "asc" },
    });
  });
}

export async function processClaimed(
  prisma: PrismaClient,
  kafka: ProducerInstance,
  events: OutboxEvent[],
  maxAttempts?: number,
): Promise<void> {
  const limit = maxAttempts ?? defaults.maxAttempts();

  for (const event of events) {
    // Correlation is per-event: each publish runs inside ITS OWN event's
    // correlation context (a batch may contain unrelated events), instead of
    // inheriting the first event's id for the whole batch.
    await runWithCorrelation(event.correlationId ?? undefined, async () => {
      try {
        const payload = coercePayload(event.payload);

        await kafka.publish(event.topic, payload, {
          key: event.partitionKey,
          correlationId: event.correlationId ?? undefined,
          eventId: event.eventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          source: event.source,
        });

        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: "SENT", processedAt: new Date() },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = isRetryablePublishError(err);

        if (retryable && event.attempts < limit) {
          const delay = retryDelayMs(event.attempts);
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: "PENDING",
              availableAt: new Date(Date.now() + delay),
              lastError: message,
            },
          });
        } else {
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: "FAILED",
              lastError: retryable
                ? `Max attempts (${limit}) exceeded: ${message}`
                : message,
            },
          });
        }
      }
    });
  }
}

export async function sweepStaleClaims(
  prisma: PrismaClient,
  timeoutMs?: number,
): Promise<number> {
  const timeout = timeoutMs ?? defaults.processingTimeoutMs();
  const cutoff = new Date(Date.now() - timeout);

  const result = await prisma.outboxEvent.updateMany({
    where: {
      status: "PROCESSING",
      claimedAt: { lt: cutoff },
    },
    data: {
      status: "PENDING",
      claimedAt: null,
      claimedBy: null,
      availableAt: new Date(),
    },
  });

  return result.count;
}

export interface OutboxQuery {
  status?: OutboxEvent["status"] | OutboxEvent["status"][];
  topic?: string;
  eventId?: string;
  limit?: number;
  /** Only PROCESSING rows whose claim is older than this (stale). */
  staleOlderThanMs?: number;
  /** Rows created before now - X (oldest-first inspection). */
  olderThanMs?: number;
}

/**
 * Inspect outbox events for operations tooling. Returns rows ordered
 * oldest-first (bounded by `limit`). Supports filtering by status, topic,
 * eventId, stale PROCESSING claims and minimum age.
 */
export async function findOutboxEvents(
  prisma: PrismaClient,
  filter: OutboxQuery = {},
): Promise<OutboxEvent[]> {
  const where: Prisma.OutboxEventWhereInput = {};
  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status)
      ? { in: filter.status }
      : filter.status;
  }
  if (filter.topic) where.topic = filter.topic;
  if (filter.eventId) where.eventId = filter.eventId;
  if (filter.staleOlderThanMs) {
    where.claimedAt = { lt: new Date(Date.now() - filter.staleOlderThanMs) };
  }
  if (filter.olderThanMs) {
    where.createdAt = { lt: new Date(Date.now() - filter.olderThanMs) };
  }
  return prisma.outboxEvent.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: filter.limit ?? 100,
  });
}

export interface OutboxResetInput {
  /** Reset a specific event by its (stable) eventId. */
  eventId?: string;
  /** Reset rows for a topic. */
  topic?: string;
  /** Statuses to reset. Default: FAILED only. Use ["FAILED","PROCESSING"] to also reclaim stale PROCESSING claims. */
  statuses?: OutboxEvent["status"][];
  /** Max rows to reset (safety bound). */
  limit?: number;
}

/**
 * Safely retry previously failed outbox events by resetting them to PENDING.
 * The original `eventId` is preserved, so when the outbox worker re-publishes,
 * consumer-side idempotency (unique consumerId+eventId) prevents duplicate
 * business effects even if the event had already partially taken effect.
 * Returns the number of rows reset.
 */
export async function resetOutboxEvents(
  prisma: PrismaClient,
  input: OutboxResetInput,
): Promise<{ reset: number }> {
  const where: Prisma.OutboxEventWhereInput = {
    status: { in: input.statuses ?? ["FAILED"] },
  };
  if (input.eventId) where.eventId = input.eventId;
  if (input.topic) where.topic = input.topic;

  if (input.limit !== undefined) {
    const ids = (
      await prisma.outboxEvent.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      })
    ).map((row) => row.id);
    if (ids.length === 0) return { reset: 0 };
    where.id = { in: ids };
  }

  const result = await prisma.outboxEvent.updateMany({
    where,
    data: {
      status: "PENDING",
      availableAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
    },
  });
  return { reset: result.count };
}

export function startOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const {
    prisma,
    kafka,
    workerId,
    log = (level, message) =>
      console[level === "error" ? "error" : "log"](
        `[outbox:${workerId}] ${message}`,
      ),
  } = options;

  const pollInterval = options.pollIntervalMs ?? defaults.pollIntervalMs();
  const sweepInterval = options.sweepIntervalMs ?? defaults.sweepIntervalMs();

  let started = false;
  let stopped = false;
  let loopPromise: Promise<void> = Promise.resolve();
  let sweepTimer: NodeJS.Timeout | null = null;

  async function processOnce(): Promise<number> {
    const claimed = await claimOutboxBatch(prisma, workerId, options.batchSize);
    if (claimed.length > 0) {
      // Correlation is applied per event inside processClaimed.
      await processClaimed(prisma, kafka!, claimed, options.maxAttempts);
    }
    return claimed.length;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const processed = await processOnce();
        if (processed > 0) {
          log("info", `processed ${processed} outbox event(s)`);
        }
      } catch (err) {
        log(
          "error",
          `loop iteration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(pollInterval);
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    loopPromise = loop();
    sweepTimer = setInterval(() => {
      sweepStaleClaims(prisma, options.processingTimeoutMs)
        .then((count) => {
          if (count > 0)
            log(
              "warn",
              `swept ${count} stale PROCESSING claim(s) back to PENDING`,
            );
        })
        .catch((err) =>
          log(
            "error",
            `sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }, sweepInterval);
    sweepTimer.unref?.();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    await loopPromise;
  }

  return {
    start,
    stop,
    sweep: () => sweepStaleClaims(prisma, options.processingTimeoutMs),
    processOnce,
  };
}

// 1. enqueueOutboxEvent()
//    → job.applied event ကို database ထဲသိမ်း
//    → status = PENDING

// 2. claimOutboxBatch()
//    → worker က event ကိုယူ
//    → status = PROCESSING

// 3. processClaimed()
//    → Kafka ကို publish လုပ်

// 4. အောင်မြင်ရင်
//    → status = SENT

// 5. Kafka ခဏ down ဖြစ်ရင်
//    → status = PENDING
//    → နောက်မှ retry

// 6. Retry limit ပြည့်ရင်
//    → status = FAILED

// 7. Worker crash ဖြစ်ပြီး PROCESSING stuck ဖြစ်ရင်
//    → sweepStaleClaims()
//    → status = PENDING ပြန်ပြောင်း

// 8. startOutboxWorker()
//    → ဒီအလုပ်တွေကို အလိုအလျောက် ထပ်ခါထပ်ခါလုပ်

//    newEventId()
// = Event ID အသစ်ထုတ်

// enqueueOutboxEvent()
// = Kafka ပို့ရမယ့် event ကို database ထဲ PENDING သိမ်း

// coercePayload()
// = Payload ကို object ပုံစံပြင်

// isRetryablePublishError()
// = Error ကို retry လုပ်သင့်/မလုပ်သင့် ဆုံးဖြတ်

// retryDelayMs()
// = နောက် retry မလုပ်ခင် စောင့်ရမယ့်အချိန်တွက်

// claimOutboxBatch()
// = Worker က ပို့ရမယ့် event ကို တာဝန်ယူယူ

// processClaimed()
// = ယူထားတဲ့ event ကို Kafka ပို့ပြီး SENT/PENDING/FAILED ပြောင်း

// sweepStaleClaims()
// = Worker ပျက်လို့ stuck ဖြစ်နေတဲ့ event ကို PENDING ပြန်ထား

// startOutboxWorker()
// = အထက်က အလုပ်အားလုံးကို အလိုအလျောက်လုပ်တဲ့ worker တည်ဆောက်

// processOnce()
// = Worker အလုပ်တစ်ကြိမ်လုပ်

// loop()
// = processOnce() ကို ထပ်ခါထပ်ခါလုပ်

// start()
// = loop နဲ့ sweep timer စတင်

// stop()
// = loop နဲ့ timer ကို သေချာရပ်
