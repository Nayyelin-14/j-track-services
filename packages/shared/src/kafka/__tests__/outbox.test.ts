import { describe, it, expect, beforeEach } from "vitest";
import type { OutboxEvent } from "@prisma/client";

import {
  enqueueOutboxEvent,
  claimOutboxBatch,
  processClaimed,
  sweepStaleClaims,
  isRetryablePublishError,
  retryDelayMs,
  newEventId,
  findOutboxEvents,
  resetOutboxEvents,
} from "../outbox.js";
import { getCorrelationId } from "../correlation.js";

interface Row {
  id: number;
  eventId: string;
  eventType: string;
  eventVersion: number;
  topic: string;
  partitionKey: string | null;
  source: string;
  correlationId: string | null;
  payload: { type: string; job_id?: number };
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  processedAt: Date | null;
  lastError: string | null;
}

function makeEvent(i: number, overrides?: Partial<Row>): Row {
  return {
    id: i,
    eventId: newEventId(),
    eventType: "job.applied",
    eventVersion: 1,
    topic: "job-events",
    partitionKey: "10",
    source: "job-service",
    correlationId: null,
    payload: { type: "job.applied", job_id: i },
    status: "PENDING",
    attempts: 0,
    availableAt: new Date(Date.now() - 1000),
    createdAt: new Date(),
    claimedAt: null,
    claimedBy: null,
    processedAt: null,
    lastError: null,
    ...overrides,
  };
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { increment?: number }).increment === "number"
    ) {
      (row as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
    } else {
      (row as unknown as Record<string, unknown>)[k] = v;
    }
  }
}

function makePrisma(rows: Row[]) {
  let nextId = 1000;

  const outboxEvent = {
    async create({ data }: { data: Partial<Row> }) {
      const row: Row = {
        ...makeEvent(nextId),
        ...data,
        id: nextId++,
      } as Row;
      rows.push(row);
      return row;
    },

    async findMany(opts: {
      where?: {
        status?: Row["status"] | { in?: Row["status"][] };
        topic?: string;
        id?: { in?: number[] };
        claimedBy?: string;
        availableAt?: { lte?: Date };
        claimedAt?: { lt?: Date };
      };
      select?: { id?: boolean };
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }) {
      let result = [...rows];
      const where = opts.where ?? {};
      if (where.status !== undefined) {
        if (typeof where.status === "object" && where.status?.in) {
          const inList = where.status.in;
          result = result.filter((r) => inList.includes(r.status));
        } else {
          result = result.filter((r) => r.status === where.status);
        }
      }
      if (where.topic !== undefined) {
        result = result.filter((r) => r.topic === where.topic);
      }
      if (where.id?.in) {
        result = result.filter((r) => where.id!.in!.includes(r.id));
      }
      if (where.claimedBy !== undefined) {
        result = result.filter((r) => r.claimedBy === where.claimedBy);
      }
      if (where.availableAt?.lte) {
        result = result.filter(
          (r) => r.availableAt.getTime() <= where.availableAt!.lte!.getTime(),
        );
      }
      if (where.claimedAt?.lt) {
        result = result.filter(
          (r) => r.claimedAt !== null && r.claimedAt.getTime() < where.claimedAt!.lt!.getTime(),
        );
      }
      if (opts.orderBy?.createdAt === "asc") {
        result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (opts.take !== undefined) {
        result = result.slice(0, opts.take);
      }
      return result;
    },

    async updateMany(opts: {
      where?: {
        id?: { in?: number[] };
        status?: Row["status"] | { in?: Row["status"][] };
        claimedAt?: { lt?: Date };
      };
      data: Partial<Row>;
    }) {
      let matched = 0;
      for (const r of rows) {
        const w = opts.where ?? {};
        const idOk = w.id?.in ? w.id.in!.includes(r.id) : true;
        let statusOk = true;
        if (w.status !== undefined) {
          statusOk =
            typeof w.status === "object" && w.status.in
              ? w.status.in.includes(r.status)
              : r.status === w.status;
        }
        const claimOk = w.claimedAt?.lt
          ? r.claimedAt !== null && r.claimedAt.getTime() < w.claimedAt.lt.getTime()
          : true;
        if (idOk && statusOk && claimOk) {
          applyData(r, opts.data as Record<string, unknown>);
          matched++;
        }
      }
      return { count: matched };
    },

    async update(opts: { where: { id: number }; data: Partial<Row> }) {
      const r = rows.find((row) => row.id === opts.where.id);
      if (!r) throw new Error("row not found");
      applyData(r, opts.data as Record<string, unknown>);
      return r;
    },
  };

  return {
    rows,
    outboxEvent,
    $transaction: <T>(fn: (tx: { outboxEvent: typeof outboxEvent }) => T) =>
      fn({ outboxEvent }),
  } as any;
}

function makeKafka(overrides?: { onPublish?: () => void }) {
  return {
    async publish() {
      overrides?.onPublish?.();
    },
  } as any;
}

describe("outbox: CAS claim", () => {
  let rows: Row[];
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    rows = [makeEvent(1), makeEvent(2), makeEvent(3)];
    prisma = makePrisma(rows);
  });

  it("claims only PENDING rows and returns the claimed set", async () => {
    const claimed = await claimOutboxBatch(prisma, "worker-a", 10);
    expect(claimed.map((c) => c.id).sort()).toEqual([1, 2, 3]);
    for (const r of rows) {
      expect(r.status).toBe("PROCESSING");
      expect(r.claimedBy).toBe("worker-a");
      expect(r.attempts).toBe(1);
    }
  });

  it("does NOT claim rows already PROCESSING (skips other workers' rows)", async () => {
    rows[0] = makeEvent(1, { status: "PROCESSING", claimedBy: "worker-other" });
    const claimed = await claimOutboxBatch(prisma, "worker-a", 10);
    expect(claimed.map((c) => c.id).sort()).toEqual([2, 3]);
  });

  it("two workers cannot claim the same row via CAS (updateMany WHERE status=PENDING)", async () => {
    const [w1, w2] = await Promise.all([
      claimOutboxBatch(prisma, "worker-a", 10),
      claimOutboxBatch(prisma, "worker-b", 10),
    ]);
    const claimedByA = w1.filter((c) => c.claimedBy === "worker-a");
    const claimedByB = w2.filter((c) => c.claimedBy === "worker-b");
    const overlap = claimedByA.filter((a) =>
      claimedByB.some((b) => b.id === a.id),
    );
    expect(overlap).toEqual([]);
    const totalClaimed = new Set([...w1, ...w2].map((c) => c.id));
    expect(totalClaimed.size).toBe(3);
    for (const r of rows) {
      expect(r.status).toBe("PROCESSING");
    }
  });

  it("respects availableAt (backoff scheduling): future events are not claimed", async () => {
    rows[2] = makeEvent(3, { availableAt: new Date(Date.now() + 60_000) });
    const claimed = await claimOutboxBatch(prisma, "worker-a", 10);
    expect(claimed.map((c) => c.id).sort()).toEqual([1, 2]);
  });
});

describe("outbox: process + retry", () => {
  let rows: Row[];
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    rows = [makeEvent(1)];
    prisma = makePrisma(rows);
  });

  it("marks SENT after successful publish", async () => {
    const kafka = makeKafka();
    await processClaimed(prisma, kafka, [rows[0]] as unknown as OutboxEvent[], 3);
    const sent = prisma.rows.find((r: Row) => r.id === 1) as Row;
    expect(sent.status).toBe("SENT");
    expect(sent.processedAt).not.toBeNull();
  });

  it("retries retryable errors with backoff (PENDING + future availableAt)", async () => {
    const kafka = makeKafka({
      onPublish: () => {
        const e = new Error("Connection refused") as Error & { retriable?: boolean };
        e.name = "KafkaJSConnectionError";
        e.retriable = true;
        throw e;
      },
    });
    const batch = [{ ...rows[0], attempts: 1 }] as unknown as OutboxEvent[];
    await processClaimed(prisma, kafka, batch, 3);
    const row = prisma.rows.find((r: Row) => r.id === 1) as Row;
    expect(row.status).toBe("PENDING");
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toContain("Connection refused");
  });

  it("FAILED on non-retryable error (no retry)", async () => {
    const kafka = makeKafka({
      onPublish: () => {
        const e = new Error("Invalid payload");
        e.name = "KafkaJSNonRetriableError";
        throw e;
      },
    });
    const batch = [{ ...rows[0], attempts: 3 }] as unknown as OutboxEvent[];
    await processClaimed(prisma, kafka, batch, 3);
    const row = prisma.rows.find((r: Row) => r.id === 1) as Row;
    expect(row.status).toBe("FAILED");
  });

  it("FAILED once max attempts reached even for retryable errors", async () => {
    const kafka = makeKafka({
      onPublish: () => {
        const e = new Error("Broker unreachable");
        e.name = "KafkaJSConnectionError";
        (e as Error & { retriable?: boolean }).retriable = true;
        throw e;
      },
    });
    const batch = [{ ...rows[0], attempts: 3 }] as unknown as OutboxEvent[];
    await processClaimed(prisma, kafka, batch, 3);
    const row = prisma.rows.find((r: Row) => r.id === 1) as Row;
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("Max attempts");
  });
});

describe("outbox: sweeper", () => {
  it("resets stale PROCESSING claims back to PENDING", async () => {
    const stale = makeEvent(1, {
      status: "PROCESSING",
      claimedBy: "dead-worker",
      claimedAt: new Date(Date.now() - 120_000),
    });
    const prisma = makePrisma([stale]);
    const swept = await sweepStaleClaims(prisma, 60_000);
    expect(swept).toBe(1);
    const row = prisma.rows[0] as Row;
    expect(row.status).toBe("PENDING");
    expect(row.claimedBy).toBeNull();
    expect(row.claimedAt).toBeNull();
  });

  it("does not touch recent PROCESSING claims", async () => {
    const active = makeEvent(1, {
      status: "PROCESSING",
      claimedBy: "alive-worker",
      claimedAt: new Date(),
    });
    const prisma = makePrisma([active]);
    const swept = await sweepStaleClaims(prisma, 60_000);
    expect(swept).toBe(0);
    expect(prisma.rows[0].status).toBe("PROCESSING");
  });
});

describe("outbox: error classification", () => {
  it("classifies retryable Kafka errors", () => {
    const e = new Error("connect refused") as Error & { retriable?: boolean };
    e.name = "KafkaJSConnectionError";
    e.retriable = true;
    expect(isRetryablePublishError(e)).toBe(true);
  });

  it("classifies non-retryable Kafka errors", () => {
    const e = new Error("bad") as Error & { retriable?: boolean };
    e.name = "KafkaJSNonRetriableError";
    expect(isRetryablePublishError(e)).toBe(false);
  });

  it("backoff grows exponentially with attempts", () => {
    const delays = [1, 2, 3].map((a) => retryDelayMs(a));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });
});

describe("outbox: enqueue helper", () => {
  it("persists an event with a stable eventId inside a transaction", async () => {
    const rows: Row[] = [];
    const prisma = makePrisma(rows);
    const eventId = newEventId();
    const created = await prisma.$transaction((tx: any) =>
      enqueueOutboxEvent(tx, {
        eventId,
        eventType: "job.applied",
        topic: "job-events",
        partitionKey: "42",
        source: "job-service",
        payload: { type: "job.applied", job_id: 42 },
      }),
    );
    expect(created.eventId).toBe(eventId);
    expect(rows[0].eventId).toBe(eventId);
    expect(rows[0].status).toBe("PENDING");
  });
});

describe("outbox: per-event correlation (hardening)", () => {
  it("processClaimed runs each publish in ITS OWN event's correlation context", async () => {
    const captured: (string | null)[] = [];
    const kafka = {
      async publish() {
        captured.push(getCorrelationId());
      },
    } as never;
    const rows: Row[] = [
      makeEvent(1, { correlationId: "corr-A" }),
      makeEvent(2, { correlationId: "corr-B" }),
    ];
    const prisma = makePrisma(rows);
    await processClaimed(
      prisma,
      kafka,
      rows as unknown as OutboxEvent[],
      3,
    );
    expect(captured).toEqual(["corr-A", "corr-B"]);
  });

  it("events without a correlationId run outside any inherited correlation", async () => {
    const captured: (string | null)[] = [];
    const kafka = {
      async publish() {
        captured.push(getCorrelationId());
      },
    } as never;
    const rows: Row[] = [makeEvent(1, { correlationId: null })];
    const prisma = makePrisma(rows);
    await processClaimed(prisma, kafka, rows as unknown as OutboxEvent[], 3);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toBe("corr-A"); // no leakage from prior events
  });
});

describe("outbox: ops tooling helpers (hardening)", () => {
  it("findOutboxEvents filters by status", async () => {
    const rows: Row[] = [
      makeEvent(1, { status: "PENDING" }),
      makeEvent(2, { status: "FAILED", topic: "send-mail" }),
      makeEvent(3, { status: "PROCESSING" }),
    ];
    const prisma = makePrisma(rows);
    const failed = await findOutboxEvents(prisma, { status: "FAILED" });
    expect(failed.map((f) => f.id)).toEqual([2]);
  });

  it("findOutboxEvents filters by topic", async () => {
    const rows: Row[] = [
      makeEvent(1, { topic: "job-events" }),
      makeEvent(2, { topic: "send-mail", status: "FAILED" }),
    ];
    const prisma = makePrisma(rows);
    const mail = await findOutboxEvents(prisma, { topic: "send-mail" });
    expect(mail.map((f) => f.id)).toEqual([2]);
  });

  it("findOutboxEvents finds stale PROCESSING claims", async () => {
    const rows: Row[] = [
      makeEvent(1, { status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000) }),
      makeEvent(2, { status: "PROCESSING", claimedAt: new Date() }),
    ];
    const prisma = makePrisma(rows);
    const stale = await findOutboxEvents(prisma, { staleOlderThanMs: 60_000 });
    expect(stale.map((f) => f.id)).toEqual([1]);
  });

  it("resetOutboxEvents resets FAILED → PENDING preserving eventId, untouched rows stay", async () => {
    const rows: Row[] = [
      makeEvent(1, { status: "FAILED", eventId: "stable-1", lastError: "boom" }),
      makeEvent(2, { status: "SENT", eventId: "sent-2" }),
    ];
    const prisma = makePrisma(rows);
    const { reset } = await resetOutboxEvents(prisma, {});
    expect(reset).toBe(1);
    const row = prisma.rows.find((r: Row) => r.id === 1) as Row;
    expect(row.status).toBe("PENDING");
    expect(row.eventId).toBe("stable-1");
    expect(row.lastError).toBeNull();
    expect(row.claimedBy).toBeNull();
    expect(prisma.rows.find((r: Row) => r.id === 2)?.status).toBe("SENT");
  });

  it("resetOutboxEvents can also reclaim stale PROCESSING claims", async () => {
    const rows: Row[] = [
      makeEvent(1, { status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000), claimedBy: "dead" }),
    ];
    const prisma = makePrisma(rows);
    const { reset } = await resetOutboxEvents(prisma, {
      statuses: ["FAILED", "PROCESSING"],
    });
    expect(reset).toBe(1);
    expect(prisma.rows[0].status).toBe("PENDING");
    expect(prisma.rows[0].claimedBy).toBeNull();
  });
});