import { describe, it, expect, vi } from "vitest";
import { getKafkaProducer } from "../producer.js";

interface FakeProducer {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeFakeProducer(overrides?: {
  sendImpl?: () => Promise<void>;
}): { producer: FakeProducer; listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  const producer: FakeProducer = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => overrides?.sendImpl?.() ?? undefined),
    on: vi.fn((event: string, cb: () => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    }),
  };
  return { producer, listeners };
}

function makeFakeKafka() {
  return { admin: () => ({ connect: async () => {}, disconnect: async () => {} }) };
}

function fire(listeners: Map<string, Array<() => void>>, event: string) {
  for (const cb of listeners.get(event) ?? []) cb();
}

describe("producer connection lifecycle + reconnect (hardening)", () => {
  it("keeps state.connected true after connect()", async () => {
    const { producer, listeners } = makeFakeProducer();
    const kafka = makeFakeKafka();
    const inst = getKafkaProducer("test-connected-flag", {
      build: () => ({ kafka: kafka as never, producer: producer as never }),
    });
    await inst.connect();
    expect(inst.isConnected()).toBe(true);
    expect(producer.on).toHaveBeenCalledWith("producer.connect", expect.any(Function));
    expect(producer.on).toHaveBeenCalledWith("producer.disconnect", expect.any(Function));
    void listeners;
  });

  it("recovers after a broker disconnect: next publish reconnects and succeeds", async () => {
    const { producer, listeners } = makeFakeProducer();
    const kafka = makeFakeKafka();
    const inst = getKafkaProducer("test-reconnect-after-disconnect", {
      build: () => ({ kafka: kafka as never, producer: producer as never }),
    });

    await inst.connect();
    expect(inst.isConnected()).toBe(true);
    expect(producer.connect).toHaveBeenCalledTimes(1);

    // Simulate a broker drop: KafkaJS emits producer.disconnect.
    fire(listeners, "producer.disconnect");
    expect(inst.isConnected()).toBe(false);

    // A publish while disconnected must re-establish the session, not throw
    // "not connected", and must not open duplicate connections (connect()
    // dedups concurrent attempts via PENDING_CONNECTIONS).
    await inst.publish("job-events", { type: "job.viewed", job_id: 1 }, { key: "job-1" });
    expect(producer.connect).toHaveBeenCalledTimes(2);
    expect(producer.send).toHaveBeenCalledTimes(1);
    expect(inst.isConnected()).toBe(true);
  });

  it("invalidates the connected belief after a retryable send failure (silent broker drop), then self-heals", async () => {
    const { producer } = makeFakeProducer({
      sendImpl: async () => {
        throw Object.assign(new Error("broker unreachable"), { name: "KafkaJSConnectionError" });
      },
    });
    const kafka = makeFakeKafka();
    const inst = getKafkaProducer("test-send-failure-invalidates", {
      build: () => ({ kafka: kafka as never, producer: producer as never }),
    });

    await inst.connect();
    expect(inst.isConnected()).toBe(true);

    // A connectivity error means the session may be dead even though no
    // disconnect event fired; the next publish must reconnect instead of
    // reusing a poisoned session forever.
    await expect(inst.publish("t", { a: 1 })).rejects.toThrow();
    expect(inst.isConnected()).toBe(false);

    producer.send.mockResolvedValueOnce(undefined);
    await inst.publish("t", { a: 2 });
    expect(producer.connect).toHaveBeenCalledTimes(2);
    expect(inst.isConnected()).toBe(true);
  });

  it("explicit disconnect() flips state.connected to false and is idempotent", async () => {
    const { producer } = makeFakeProducer();
    const kafka = makeFakeKafka();
    const inst = getKafkaProducer("test-explicit-disconnect", {
      build: () => ({ kafka: kafka as never, producer: producer as never }),
    });
    await inst.connect();
    await inst.disconnect();
    expect(inst.isConnected()).toBe(false);
    expect(producer.disconnect).toHaveBeenCalledTimes(1);
    // Second disconnect is a no-op (already disconnected).
    await inst.disconnect();
    expect(producer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("publish wraps payloads in an envelope and preserves the correlation header", async () => {
    const { producer } = makeFakeProducer();
    const kafka = makeFakeKafka();
    const inst = getKafkaProducer("test-publish-envelope", {
      build: () => ({ kafka: kafka as never, producer: producer as never }),
    });
    await inst.connect();
    await inst.publish("send-mail", { to: "a@b.c" }, { correlationId: "corr-1" });
    const call = producer.send.mock.calls[0][0] as {
      messages: Array<{ value: string; headers?: Record<string, string> }>;
    };
    const parsed = JSON.parse(call.messages[0].value) as {
      eventId: string;
      eventType: string;
      correlationId: string;
    };
    expect(parsed.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.eventType).toBe("unknown");
    expect(parsed.correlationId).toBe("corr-1");
    expect(call.messages[0].headers).toEqual({ correlationId: "corr-1" });
  });
});