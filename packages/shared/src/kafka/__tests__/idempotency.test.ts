import { describe, it, expect, beforeEach } from "vitest";
import {
  markProcessed,
  isAlreadyProcessed,
  pruneProcessedRecords,
} from "../idempotency.js";
import { wrapInEnvelope } from "../envelope.js";

interface DedupRow {
  id: number;
  consumerId: string;
  eventId: string;
  eventType: string;
  partition: number;
  offset: bigint;
  processedAt: Date;
  occurredAt: Date | null;
}

function makePrismaDedup(rows: DedupRow[]) {
  let nextId = 1;
  let createCalls = 0;
  const consumerDedup = {
    async create({ data }: { data: Partial<DedupRow> }) {
      createCalls++;
      const collision = rows.find(
        (r) =>
          r.consumerId === data.consumerId && r.eventId === data.eventId,
      );
      if (collision) {
        const e = new Error("Unique constraint failed");
        (e as { code?: string }).code = "P2002";
        throw e;
      }
      const row: DedupRow = {
        id: nextId++,
        consumerId: data.consumerId!,
        eventId: data.eventId!,
        eventType: data.eventType!,
        partition: data.partition!,
        offset: data.offset ?? 0n,
        processedAt: data.processedAt ?? new Date(),
        occurredAt: data.occurredAt ?? null,
      };
      rows.push(row);
      return row;
    },
    async findUnique({ where }: { where: { consumerId_eventId: { consumerId: string; eventId: string } } }) {
      return (
        rows.find(
          (r) =>
            r.consumerId === where.consumerId_eventId.consumerId &&
            r.eventId === where.consumerId_eventId.eventId,
        ) ?? null
      );
    },
    async deleteMany({ where }: { where: { processedAt?: { lt?: Date } } }) {
      const cutoff = where.processedAt?.lt;
      const before = rows.length;
      const kept = rows.filter(
        (r) => !(cutoff && r.processedAt.getTime() < cutoff.getTime()),
      );
      rows.splice(0, rows.length, ...kept);
      return { count: before - kept.length };
    },
  };
  return { rows, consumerDedup, createCalls: () => createCalls, $transaction: (fn: any) => fn({ consumerDedup }) };
}

const envelope = wrapInEnvelope({
  eventId: "event-1",
  eventType: "job.applied",
  source: "test",
  occurredAt: "2026-08-13T10:00:00.000Z",
  payload: {},
});

describe("idempotency: first-time processing", () => {
  let rows: DedupRow[];
  let prisma: ReturnType<typeof makePrismaDedup>;

  beforeEach(() => {
    rows = [];
    prisma = makePrismaDedup(rows);
  });

  it("marks a new event as processed (not duplicate)", async () => {
    const rec = await markProcessed(prisma as any, {
      consumerId: "analytics",
      envelope,
      partition: 1,
      offset: 10n,
    });
    expect(rec.isDuplicate).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("isAlreadyProcessed returns false before any mark", async () => {
    expect(
      await isAlreadyProcessed(prisma as any, "analytics", "event-1"),
    ).toBe(false);
  });
});

describe("idempotency: duplicate detection (redelivery / crash-reprocess / replay)", () => {
  let rows: DedupRow[];
  let prisma: ReturnType<typeof makePrismaDedup>;

  beforeEach(() => {
    rows = [];
    prisma = makePrismaDedup(rows);
    rows.push({
      id: 1,
      consumerId: "analytics",
      eventId: "event-1",
      eventType: "job.applied",
      partition: 1,
      offset: 10n,
      processedAt: new Date(),
      occurredAt: new Date("2026-08-13T10:00:00.000Z"),
    });
  });

  it("second mark of the same eventId is flagged duplicate", async () => {
    const rec = await markProcessed(prisma as any, {
      consumerId: "analytics",
      envelope,
      partition: 1,
      offset: 11n,
    });
    expect(rec.isDuplicate).toBe(true);
    expect(rows).toHaveLength(1); // no extra row
  });

  it("same eventId for a DIFFERENT consumer is processed independently", async () => {
    const rec = await markProcessed(prisma as any, {
      consumerId: "mail",
      envelope,
      partition: 1,
      offset: 5n,
    });
    expect(rec.isDuplicate).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

describe("idempotency: crash-after-effect simulation (at-least-once)", () => {
  it("a crash after business effect but BEFORE mark lets the effect happen again on redelivery", async () => {
    const rows: DedupRow[] = [];
    const prisma = makePrismaDedup(rows);

    // Simulate: effect done, process dies before markProcessed. The dedup table
    // has no row for this event.
    expect(
      await isAlreadyProcessed(prisma as any, "mail", "event-1"),
    ).toBe(false);

    // Redelivery arrives on the next attempt -> effect runs again -> only now
    // it is marked. This is the documented at-least-once tradeoff.
    const rec = await markProcessed(prisma as any, {
      consumerId: "mail",
      envelope,
      partition: 1,
      offset: 20n,
    });
    expect(rec.isDuplicate).toBe(false);
  });
});

describe("idempotency: pruning (bounded retention)", () => {
  it("removes records older than the retention window", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const rows: DedupRow[] = [
      {
        id: 1,
        consumerId: "a",
        eventId: "old-1",
        eventType: "x",
        partition: 0,
        offset: 1n,
        processedAt: old,
        occurredAt: null,
      },
      {
        id: 2,
        consumerId: "a",
        eventId: "new-1",
        eventType: "x",
        partition: 0,
        offset: 2n,
        processedAt: new Date(),
        occurredAt: null,
      },
    ];
    const prisma = makePrismaDedup(rows);
    const pruned = await pruneProcessedRecords(prisma as any, 7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("new-1");
  });
});