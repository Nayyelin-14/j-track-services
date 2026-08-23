import type { Prisma, PrismaClient } from "@prisma/client";
import type { EventEnvelope } from "./envelope";

export interface DedupRecordInput {
  consumerId: string;
  envelope: EventEnvelope;
  partition: number;
  offset: bigint;
}

export interface DedupRecord {
  consumerId: string;
  eventId: string;
  eventType: string;
  partition: number;
  offset: bigint;
  processedAt: Date;
  occurredAt: Date | null;
  isDuplicate: boolean;
}

/**
 * Atomically record that a consumer processed an event. When the same eventId
 * is delivered again (redelivery, replay, crash-then-reprocess), the unique
 * (consumerId, eventId) constraint makes the second insert fail with P2002,
 * and we treat it as a duplicate. This gives at-least-once delivery with
 * idempotent consumers: business effects happen once per eventId.
 *
 * Marking is intentionally *before* the business effect; if the effect fails,
 * the caller deletes the record (or lets the transaction roll back) so a retry
 * still processes the event.
 */
export async function markProcessed(
  prisma: PrismaClient,
  input: DedupRecordInput,
): Promise<DedupRecord> {
  try {
    const row = await prisma.consumerDedup.create({
      data: {
        consumerId: input.consumerId,
        eventId: input.envelope.eventId,
        eventType: input.envelope.eventType,
        partition: input.partition,
        offset: input.offset,
        processedAt: new Date(),
        occurredAt: input.envelope.occurredAt
          ? new Date(input.envelope.occurredAt)
          : null,
      },
    });
    return { ...row, isDuplicate: false };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const existing = await prisma.consumerDedup.findUnique({
        where: {
          consumerId_eventId: {
            consumerId: input.consumerId,
            eventId: input.envelope.eventId,
          },
        },
      });
      return {
        consumerId: input.consumerId,
        eventId: input.envelope.eventId,
        eventType: input.envelope.eventType,
        partition: input.partition,
        offset: input.offset,
        processedAt: existing?.processedAt ?? new Date(),
        occurredAt: existing?.occurredAt ?? null,
        isDuplicate: true,
      };
    }
    throw err;
  }
}

/**
 * A transaction-friendly variant. Use when the business effect and the dedup
 * record must commit atomically (the effect only happens when the mark is
 * durable, and the mark is rolled back if the effect fails).
 */
export async function markProcessedInTx(
  tx: Prisma.TransactionClient,
  input: DedupRecordInput,
): Promise<DedupRecord> {
  try {
    const row = await tx.consumerDedup.create({
      data: {
        consumerId: input.consumerId,
        eventId: input.envelope.eventId,
        eventType: input.envelope.eventType,
        partition: input.partition,
        offset: input.offset,
        processedAt: new Date(),
        occurredAt: input.envelope.occurredAt
          ? new Date(input.envelope.occurredAt)
          : null,
      },
    });
    return { ...row, isDuplicate: false };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return {
        consumerId: input.consumerId,
        eventId: input.envelope.eventId,
        eventType: input.envelope.eventType,
        partition: input.partition,
        offset: input.offset,
        processedAt: new Date(),
        occurredAt: null,
        isDuplicate: true,
      };
    }
    throw err;
  }
}

/**
 * Check without marking; used when the business effect is external (e.g. SMTP)
 * and cannot be transactional with the mark. The caller marks only after the
 * effect succeeds; if the process crashes between effect and mark, the event
 * will be re-delivered and re-executed (at-least-once, accepted and documented).
 */
export async function isAlreadyProcessed(
  prisma: PrismaClient,
  consumerId: string,
  eventId: string,
): Promise<boolean> {
  const existing = await prisma.consumerDedup.findUnique({
    where: {
      consumerId_eventId: { consumerId, eventId },
    },
  });
  return existing !== null;
}

/**
 * Prune dedup records older than `retentionMs`. Keeps the table bounded.
 * Returns the number of rows removed.
 */
export async function pruneProcessedRecords(
  prisma: PrismaClient,
  retentionMs = 7 * 24 * 60 * 60 * 1000,
  batchSize = 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const result = await prisma.consumerDedup.deleteMany({
    where: { processedAt: { lt: cutoff } },
  });
  void batchSize;
  return result.count;
}
