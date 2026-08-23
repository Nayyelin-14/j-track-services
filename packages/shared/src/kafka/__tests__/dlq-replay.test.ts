import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isRetryableError,
  NonRetryableError,
  runWithRetryAndDlq,
  publishToDLQ,
} from "../dlq.js";
import { parseDlqMessage, replayFromDlq } from "../replay.js";
import { wrapInEnvelope } from "../envelope.js";

function makeFakeKafka() {
  const published: { topic: string; value: string; key?: string; headers?: unknown }[] = [];
  const kafka = {
    producer: () => ({
      async connect() {},
      async send({ topic, messages }: { topic: string; messages: { key?: string; value: string; headers?: unknown }[] }) {
        for (const m of messages) published.push({ topic, value: m.value, key: m.key, headers: m.headers });
      },
      async disconnect() {},
    }),
  };
  return { kafka: kafka as never, published };
}

function makeRecord(overrides?: Record<string, unknown>) {
  const envelope = wrapInEnvelope({
    eventId: "evt-replay-1",
    eventType: "job.applied",
    source: "job-service",
    payload: { type: "job.applied" },
  });
  return {
    envelope,
    originalTopic: "job-events",
    partition: 2,
    offset: 99n,
    consumerId: "analytics",
    error: "",
    attempts: 0,
    reason: "",
    failedAt: new Date().toISOString(),
    key: null,
    ...overrides,
  };
}

describe("retry/detection: error classification (Phase 5)", () => {
  it("treats connection errors as retryable", () => {
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("connect timed out"))).toBe(true);
    expect(isRetryableError(new Error("Connection refused"))).toBe(true);
  });

  it("treats Prisma connection failures as retryable", () => {
    const e = new Error("timed out");
    e.name = "P1001";
    expect(isRetryableError(e)).toBe(true);
  });

  it("treats non-retryable marker and benign program errors as non-retryable", () => {
    expect(isRetryableError(new NonRetryableError("bad payload"))).toBe(false);
    expect(isRetryableError(new Error("Value is undefined"))).toBe(false);
  });
});

describe("retry + DLQ flow (Phase 5/6)", () => {
  it("retries transient failures with backoff until success, then returns true", async () => {
    let attempts = 0;
    const handler = async () => {
      attempts++;
      if (attempts < 3) throw new Error("ECONNRESET");
    };
    const { kafka, published } = makeFakeKafka();
    const ok = await runWithRetryAndDlq({
      kafka,
      dlqTopic: "job-events-dlq",
      record: makeRecord(),
      handler,
      policy: { maxAttempts: 3 },
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
    expect(published).toHaveLength(0); // no DLQ on eventual success
  });

  it("sends to DLQ after retries exhausted", async () => {
    const handler = async () => {
      throw new Error("ECONNRESET");
    };
    const { kafka, published } = makeFakeKafka();
    const ok = await runWithRetryAndDlq({
      kafka,
      dlqTopic: "job-events-dlq",
      record: makeRecord(),
      handler,
      policy: { maxAttempts: 3 },
    });
    expect(ok).toBe(false);
    expect(published).toHaveLength(1);
    const parsed = JSON.parse(published[0].value) as {
      reason: string;
      envelope: { eventId: string };
      attempts: number;
    };
    expect(published[0].topic).toBe("job-events-dlq");
    expect(parsed.reason).toBe("max_attempts_reached");
    expect(parsed.envelope.eventId).toBe("evt-replay-1");
    expect(parsed.attempts).toBeGreaterThan(0);
  });

  it("does NOT retry non-retryable errors - sends straight to DLQ", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      throw new NonRetryableError("malformed submission");
    };
    const { kafka, published } = makeFakeKafka();
    const ok = await runWithRetryAndDlq({
      kafka,
      dlqTopic: "job-events-dlq",
      record: makeRecord(),
      handler,
      policy: { maxAttempts: 5 },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(1); // never retried
    const parsed = JSON.parse(published[0].value) as { reason: string };
    expect(parsed.reason).toBe("non_retryable_error");
  });
});

describe("DLQ envelope (Phase 6)", () => {
  it("embeds original topic/partition/offset/consumer/error/attempts", async () => {
    const { kafka, published } = makeFakeKafka();
    await publishToDLQ(kafka, "send-mail-dlq", makeRecord({ error: "boom", attempts: 3, partition: 7, offset: 42n }));
    const parsed = JSON.parse(published[0].value);
    expect(parsed.originalTopic).toBe("job-events");
    expect(parsed.partition).toBe(7);
    expect(parsed.offset).toBe("42");
    expect(parsed.consumerId).toBe("analytics");
    expect(parsed.error).toBe("boom");
    expect(parsed.attempts).toBe(3);
    expect(parsed.envelope.eventId).toBe("evt-replay-1");
  });

  it("parseDlqMessage validates and produces a typed record", () => {
    const record = makeRecord({ error: "x", attempts: 2 });
    const dlq = {
      v: 1,
      envelope: record.envelope,
      originalTopic: "job-events",
      partition: 0,
      offset: "5",
      consumerId: "a",
      error: "x",
      attempts: 2,
      reason: "non_retryable_error",
      failedAt: new Date().toISOString(),
      key: null,
    };
    const parsed = parseDlqMessage(JSON.stringify(dlq));
    expect(parsed?.originalTopic).toBe("job-events");
    expect(parsed?.envelope.eventId).toBe("evt-replay-1");
    expect(parsed?.consumerId).toBe("a");
    expect(parseDlqMessage("garbage")).toBeNull();
  });
});

describe("DLQ publish failure durability (hardening)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("publishToDLQ retries transient write failures before giving up", async () => {
    vi.stubEnv("KAFKA_DLQ_PUBLISH_RETRIES", "3");
    vi.stubEnv("KAFKA_CONSUMER_RETRY_BASE_MS", "1");
    vi.stubEnv("KAFKA_CONSUMER_RETRY_MAX_MS", "5");
    let sends = 0;
    const kafka = {
      producer: () => ({
        async connect() {},
        async send() {
          sends++;
          if (sends < 2) {
            throw Object.assign(new Error("conn reset"), {
              name: "KafkaJSConnectionError",
              retriable: true,
            });
          }
        },
        async disconnect() {},
      }),
    } as never;

    const ok = await publishToDLQ(kafka, "send-mail-dlq", makeRecord());
    expect(ok).toBe(true);
    expect(sends).toBe(2);
  });

  it("runWithRetryAndDlq RETHROWS when the DLQ write fails, so the offset is not committed", async () => {
    vi.stubEnv("KAFKA_DLQ_PUBLISH_RETRIES", "2");
    vi.stubEnv("KAFKA_CONSUMER_RETRY_BASE_MS", "1");
    vi.stubEnv("KAFKA_CONSUMER_RETRY_MAX_MS", "5");
    const kafka = {
      producer: () => ({
        async connect() {},
        async send() {
          throw new Error("dlq topic not writable");
        },
        async disconnect() {},
      }),
    } as never;

    const onGiveUp = vi.fn();
    const onDlqWritten = vi.fn();
    const handler = async () => {
      throw new NonRetryableError("bad payload");
    };

    await expect(
      runWithRetryAndDlq({
        kafka,
        dlqTopic: "send-mail-dlq",
        record: makeRecord(),
        handler,
        policy: { maxAttempts: 3 },
        onGiveUp,
        onDlqWritten,
        log: () => undefined,
      }),
    ).rejects.toThrow("bad payload");

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onDlqWritten).not.toHaveBeenCalled();
  });

  it("calls onDlqWritten when the record is durably written to the DLQ", async () => {
    const { kafka } = makeFakeKafka();
    const onDlqWritten = vi.fn();
    const ok = await runWithRetryAndDlq({
      kafka,
      dlqTopic: "job-events-dlq",
      record: makeRecord(),
      handler: async () => {
        throw new NonRetryableError("boom");
      },
      policy: { maxAttempts: 3 },
      onDlqWritten,
      log: () => undefined,
    });
    expect(ok).toBe(false);
    expect(onDlqWritten).toHaveBeenCalledTimes(1);
  });
});

describe("replay (Phase 6)", () => {
  it("replays DLQ records to the original topic preserving eventId and key", async () => {
    const dlqValue = JSON.stringify({
      v: 1,
      envelope: wrapInEnvelope({
        eventId: "stable-event-id",
        eventType: "job.applied",
        source: "job-service",
        correlationId: "corr-9",
        payload: { type: "job.applied", job_id: 5 },
      }),
      originalTopic: "job-events",
      partition: 3,
      offset: "77",
      consumerId: "analytics",
      error: "boom",
      attempts: 3,
      reason: "max_attempts_reached",
      failedAt: new Date().toISOString(),
      key: "5",
    });

    const sentToOriginal: { key?: string; value: string; headers?: unknown }[] = [];
    const kafka = {
      consumer: () => ({
        async connect() {},
        async subscribe() {},
        async run({ eachMessage }: { eachMessage: (args: never) => Promise<void> }) {
          await eachMessage({ message: { value: Buffer.from(dlqValue), key: Buffer.from("5") } } as never);
        },
        async stop() {},
        async disconnect() {},
      }),
      producer: () => ({
        async connect() {},
        async send({ topic, messages }: { topic: string; messages: { key?: string; value: string; headers?: unknown }[] }) {
          for (const m of messages) sentToOriginal.push(m);
        },
        async disconnect() {},
      }),
    } as never;

    const result = await replayFromDlq({
      kafka,
      dlqTopic: "send-mail-dlq",
      log: () => undefined,
    });

    expect(result.replayed).toBe(1);
    expect(sentToOriginal).toHaveLength(1);
    // eventId + correlationId preserved verbatim for consumer idempotency
    const replayed = JSON.parse(sentToOriginal[0].value) as { eventId: string; correlationId?: string };
    expect(replayed.eventId).toBe("stable-event-id");
    expect(replayed.correlationId).toBe("corr-9");
    // partition key preserved
    expect(sentToOriginal[0].key).toBe("5");
  });

  it("skips malformed and filtered records", async () => {
    const kafka = {
      consumer: () => ({
        async connect() {},
        async subscribe() {},
        async run({ eachMessage }: { eachMessage: (args: never) => Promise<void> }) {
          await eachMessage({ message: { value: Buffer.from("not-json") } } as never);
          await eachMessage({
            message: {
              value: Buffer.from(
                JSON.stringify({
                  v: 1,
                  envelope: wrapInEnvelope({ eventId: "x", eventType: "y", source: "s", payload: {} }),
                  originalTopic: "job-events",
                  partition: 0,
                  offset: "1",
                  consumerId: "analytics",
                  error: "e",
                  attempts: 1,
                  reason: "r",
                  failedAt: new Date().toISOString(),
                }),
              ),
            },
          } as never);
        },
        async stop() {},
        async disconnect() {},
      }),
      producer: () => ({
        async connect() {},
        async send() {},
        async disconnect() {},
      }),
    } as never;

    const result = await replayFromDlq({
      kafka,
      dlqTopic: "send-mail-dlq",
      consumerId: "mail-service", // no mail-service records present => both skipped/filtered
      log: () => undefined,
    });
    // invalid JSON is counted invalid; the well-formed record is filtered by consumerId
    expect(result.invalid).toBe(1);
    expect(result.replayed).toBe(0);
  });
});