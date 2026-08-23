import { describe, it, expect, vi } from "vitest";
import { createConsumer } from "../consumer-factory.js";
import { wrapInEnvelope } from "../envelope.js";

interface FakeKafkaState {
  handlers: Array<
    (msg: { topic: string; partition: number; message: { value: string; offset: string } }) => Promise<void>
  >;
  crashListeners: Array<(event: { payload?: { restart?: boolean; error?: Error } }) => void>;
}

function emitCrash(state: FakeKafkaState, restart: boolean, error?: Error) {
  for (const cb of state.crashListeners) {
    cb({ payload: { restart, error } });
  }
}

function makeFakeConsumer(state: FakeKafkaState) {
  return {
    async connect() {},
    async subscribe(_: unknown) {},
    async run({ eachMessage }: { eachMessage: (args: never) => Promise<void> }) {
      state.handlers.push(eachMessage as never);
    },
    async stop() {},
    async disconnect() {},
    events: { CRASH: "consumer.crash" },
    on(eventName: string, cb: (event: { payload?: { restart?: boolean; error?: Error } }) => void) {
      if (eventName === "consumer.crash") state.crashListeners.push(cb);
    },
  };
}

function makeFakeKafka(state: FakeKafkaState) {
  const consumer = makeFakeConsumer(state);
  const kafka = {
    consumer: () => consumer,
    producer: () => ({
      async connect() {},
      async send() {},
      async disconnect() {},
    }),
  };
  return { kafka: kafka as never, consumer };
}

function envelopeJson(eventId: string, type: string, payload: unknown): string {
  return JSON.stringify(
    wrapInEnvelope({
      eventId,
      eventType: type,
      source: "test",
      correlationId: "corr-" + eventId,
      payload,
    }),
  );
}

describe("consumer scaling correctness (Phase 8)", () => {
  it("two consumer instances in the same group both stay stateless and each handle their own partition", async () => {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const { kafka } = makeFakeKafka(state);

    const processedByA: string[] = [];
    const processedByB: string[] = [];

    const consumerA = createConsumer({
      clientId: "analytics-a",
      groupId: "same-group",
      consumerId: "analytics",
      topics: ["job-events"],
      handler: async (ctx) => {
        processedByA.push(ctx.envelope.eventId);
      },
      kafka: kafka as never,
      log: () => undefined,
    });
    const consumerB = createConsumer({
      clientId: "analytics-b",
      groupId: "same-group",
      consumerId: "analytics",
      topics: ["job-events"],
      handler: async (ctx) => {
        processedByB.push(ctx.envelope.eventId);
      },
      kafka: kafka as never,
      log: () => undefined,
    });

    await consumerA.start();
    await consumerB.start();
    // Both registered their eachMessage handler; kafka assigns disjoint
    // partitions per consumer. Simulate each receiving distinct messages.
    await state.handlers[0]({ topic: "job-events", partition: 0, message: { value: envelopeJson("e1", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: new Date().toISOString() }), offset: "1" } });
    await state.handlers[1]({ topic: "job-events", partition: 1, message: { value: envelopeJson("e2", "job.applied", { type: "job.applied", job_id: 2, applicant_id: 3, applied_at: new Date().toISOString() }), offset: "2" } });

    expect(processedByA).toEqual(["e1"]);
    expect(processedByB).toEqual(["e2"]);

    await consumerA.stop();
    await consumerB.stop();
  });
});

describe("consumer factory failure handling (Phase 13)", () => {
  it("consumers skip malformed JSON without crashing the loop", async () => {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const { kafka } = makeFakeKafka(state);
    const logSpy = vi.fn();
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {},
      kafka: kafka as never,
      log: logSpy,
    });
    await consumer.start();
    // malformed -> logged error, no DLQ, loop continues
    await state.handlers[0]({ topic: "t", partition: 0, message: { value: "not-json{", offset: "0" } });
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[1]).includes("Invalid JSON"))).toBe(true);
    await consumer.stop();
  });

  it("consumer handles a message, runs the handler within the envelope's correlation context", async () => {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const { kafka } = makeFakeKafka(state);
    const seen: (string | undefined)[] = [];
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async (ctx) => {
        seen.push(ctx.envelope.correlationId);
      },
      kafka: kafka as never,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "t",
      partition: 0,
      message: {
        value: envelopeJson("ev-1", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: "2026-08-13T00:00:00Z" }),
        offset: "0",
      },
    });
    expect(seen).toContain("corr-ev-1");
    await consumer.stop();
  });
});

describe("consumer factory validation + DLQ durability (hardening)", () => {
  interface ProducerRecord {
    topic: string;
    value: string;
  }

  function makeFakeKafkaWithProducer(
    records: ProducerRecord[],
    sendImpl?: () => Promise<void>,
  ) {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const consumer = makeFakeConsumer(state);
    const kafka = {
      consumer: () => consumer,
      producer: () => ({
        async connect() {},
        async send({ topic, messages }: { topic: string; messages: { value: string }[] }) {
          await sendImpl?.();
          for (const m of messages) records.push({ topic, value: m.value });
        },
        async disconnect() {},
      }),
    };
    return { kafka: kafka as never, consumer, state };
  }

  it("routes an invalid payload to the DLQ (non-retryable) and never runs the handler", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    let handlerRan = false;
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["job-events"],
      handler: async () => {
        handlerRan = true;
      },
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "job-events",
      partition: 0,
      message: {
        value: envelopeJson("e-invalid", "job.applied", { type: "job.applied" }),
        offset: "5",
      },
    });
    expect(handlerRan).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].topic).toBe("dlq");
    const dlq = JSON.parse(records[0].value) as { reason: string; error: string; envelope: { eventId: string } };
    expect(dlq.reason).toBe("invalid_payload");
    expect(dlq.envelope.eventId).toBe("e-invalid");
    await consumer.stop();
  });

  it("routes an unknown eventType to the DLQ as unknown_event_type", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {},
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "t",
      partition: 0,
      message: {
        value: envelopeJson("e-unknown", "mystery.event", {}),
        offset: "1",
      },
    });
    expect(records).toHaveLength(1);
    const dlq = JSON.parse(records[0].value) as { reason: string };
    expect(dlq.reason).toBe("unknown_event_type");
    await consumer.stop();
  });

  it("routes an unsupported eventVersion to the DLQ as unsupported_version", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["job-events"],
      handler: async () => {},
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    const envelope = wrapInEnvelope({
      eventId: "e-ver",
      eventType: "job.applied",
      eventVersion: 99,
      source: "s",
      payload: { type: "job.applied", job_id: 1, applicant_id: 2, applied_at: "x" },
    });
    await state.handlers[0]({
      topic: "job-events",
      partition: 0,
      message: { value: JSON.stringify(envelope), offset: "1" },
    });
    expect(records).toHaveLength(1);
    const dlq = JSON.parse(records[0].value) as { reason: string };
    expect(dlq.reason).toBe("unsupported_version");
    await consumer.stop();
  });

  it("a handler failure whose DLQ write also fails REJECTS the message (offset not committed)", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records, async () => {
      throw new Error("dlq down");
    });
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {
        throw new Error("handler bug");
      },
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await expect(
      state.handlers[0]({
        topic: "t",
        partition: 0,
        message: {
          value: envelopeJson("e-fail", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: "2026-08-13T00:00:00Z" }),
          offset: "9",
        },
      }),
    ).rejects.toThrow(/handler bug/);
    expect(records).toHaveLength(0);
    await consumer.stop();
  });

  it("a handler failure with a successful DLQ write resolves normally (offset committed)", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {
        throw new Error("handler bug");
      },
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "t",
      partition: 0,
      message: {
        value: envelopeJson("e-fail2", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: "2026-08-13T00:00:00Z" }),
        offset: "10",
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0].topic).toBe("dlq");
    const dlq = JSON.parse(records[0].value) as { reason: string };
    expect(dlq.reason).toBe("non_retryable_error");
    await consumer.stop();
  });

  it("a message skipped by shouldProcess is consumed without DLQ", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["job-events"],
      shouldProcess: (envelope) => {
        const payload = envelope.payload as { type?: string };
        return payload?.type === "job.applied";
      },
      handler: async () => {},
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "job-events",
      partition: 0,
      message: {
        value: envelopeJson("e-skip", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: "2026-08-13T00:00:00Z" }),
        offset: "1",
      },
    });
    expect(records).toHaveLength(0);
    await consumer.stop();
  });

  it("a throwing shouldProcess is treated as a poison event and routed to the DLQ", async () => {
    const records: ProducerRecord[] = [];
    const { kafka, state } = makeFakeKafkaWithProducer(records);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      shouldProcess: () => {
        throw new Error("filter bug");
      },
      handler: async () => {},
      kafka,
      log: () => undefined,
    });
    await consumer.start();
    await state.handlers[0]({
      topic: "t",
      partition: 0,
      message: {
        value: envelopeJson("e-filter", "job.viewed", { type: "job.viewed", job_id: 1, viewed_at: "2026-08-13T00:00:00Z" }),
        offset: "1",
      },
    });
    expect(records).toHaveLength(1);
    const dlq = JSON.parse(records[0].value) as { reason: string };
    expect(dlq.reason).toBe("invalid_payload");
    await consumer.stop();
  });
});

describe("consumer readiness semantics (hardening)", () => {
  it("reports NOT running after a permanent (non-restartable) KafkaJS crash - readiness degrades", async () => {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const { kafka, consumer: fakeConsumer } = makeFakeKafka(state);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {},
      kafka: kafka as never,
      log: () => undefined,
    });
    await consumer.start();
    expect(consumer.isRunning()).toBe(true);
    void fakeConsumer;

    // KafkaJS reports a permanent crash (e.g. our rethrown DLQ failure) with
    // restart === false. The factory must flip isRunning() so readiness 503s
    // instead of reporting a healthy consumer that is actually dead.
    emitCrash(state, false, new Error("DLQ write failed"));
    expect(consumer.isRunning()).toBe(false);
    await consumer.stop();
  });

  it("stays running when KafkaJS crashes but will auto-restart (restart === true)", async () => {
    const state: FakeKafkaState = { handlers: [], crashListeners: [] };
    const { kafka } = makeFakeKafka(state);
    const consumer = createConsumer({
      clientId: "t",
      groupId: "g",
      consumerId: "c",
      topics: ["t"],
      handler: async () => {},
      kafka: kafka as never,
      log: () => undefined,
    });
    await consumer.start();
    emitCrash(state, true, new Error("transient fetch error"));
    expect(consumer.isRunning()).toBe(true);
    await consumer.stop();
  });
});