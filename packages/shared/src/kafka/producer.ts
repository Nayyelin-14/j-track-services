import { Kafka, Producer } from "kafkajs";
import { ProducerInstance, KafkaHealth, PublishOptions } from "./types";
import { sleep, resolveKafkaConfig } from "./config";
import { wrapInEnvelope, isEnvelope } from "./envelope";
import { isRetryablePublishError } from "./outbox";

const REGISTRY = new Map<
  string,
  { kafka: Kafka; producer: Producer; connected: boolean }
>();
const PENDING_CONNECTIONS = new Map<string, Promise<void>>();

async function connectWithBackoff(
  producer: Producer,
  maxRetries = 5,
): Promise<void> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await producer.connect();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        const delay = Math.min(1000 * 2 ** i, 15000);
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error("Failed to connect to Kafka");
}

export interface KafkaProducerDeps {
  /**
   * Injectable { kafka, producer } factory. Defaults to a real KafkaJS
   * client built from env config. Used by tests to avoid a live broker.
   */
  build?: () => { kafka: Kafka; producer: Producer };
}

function createDefaultProducer(clientId: string): {
  kafka: Kafka;
  producer: Producer;
} {
  const config = resolveKafkaConfig(clientId);
  const kafka = new Kafka(config);
  const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
  });
  return { kafka, producer };
}

export function getKafkaProducer(
  clientId: string,
  deps?: KafkaProducerDeps,
): ProducerInstance {
  const existing = REGISTRY.get(clientId);
  if (existing) {
    return buildInterface(clientId, existing);
  }

  const { kafka, producer } = deps?.build?.() ?? createDefaultProducer(clientId);
  const state = { kafka, producer, connected: false };

  // Keep `state.connected` honest. Before this, a broker drop after startup
  // left the flag `true` forever, so nothing ever re-established the session
  // and every later publish failed against a dead connection. These events
  // make connect()/publish() self-healing and prevent duplicate connects.
  producer.on("producer.connect", () => {
    state.connected = true;
  });
  producer.on("producer.disconnect", () => {
    state.connected = false;
  });

  REGISTRY.set(clientId, state);
  return buildInterface(clientId, state);
}

function buildInterface(
  clientId: string,
  state: { kafka: Kafka; producer: Producer; connected: boolean },
): ProducerInstance {
  return {
    async connect(): Promise<void> {
      if (state.connected) return;

      const pending = PENDING_CONNECTIONS.get(clientId);
      if (pending) return pending;

      const promise = (async () => {
        const retries = Number(process.env.KAFKA_CONNECT_RETRIES) || 5;
        await connectWithBackoff(state.producer, retries);
        state.connected = true;
      })();

      PENDING_CONNECTIONS.set(clientId, promise);
      try {
        await promise;
      } finally {
        PENDING_CONNECTIONS.delete(clientId);
      }
    },

    async publish<T = Record<string, unknown>>(
      topic: string,
      message: T,
      options?: PublishOptions,
    ): Promise<void> {
      // Self-heal: if a disconnect happened since connect() (broker blip,
      // idle session close), reconnect before sending instead of failing.
      if (!state.connected) {
        await this.connect();
      }

      const alreadyEnveloped = isEnvelope(message);
      const envelope = alreadyEnveloped
        ? (message as unknown as { eventType?: string })
        : wrapInEnvelope({
            eventId: options?.eventId,
            eventType:
              options?.eventType ??
              (typeof (message as Record<string, unknown>)["type"] === "string"
                ? ((message as Record<string, unknown>)["type"] as string)
                : "unknown"),
            eventVersion: options?.eventVersion ?? 1,
            occurredAt: options?.occurredAt,
            source: options?.source ?? clientId,
            correlationId: options?.correlationId,
            payload: message as T,
          });

      try {
        await state.producer.send({
          topic,
          messages: [
            {
              key: options?.key ?? null,
              value: JSON.stringify(envelope),
              headers: options?.correlationId
                ? { correlationId: options.correlationId }
                : undefined,
            },
          ],
        });
      } catch (err) {
        // A connectivity error means the session may be poisoned even though
        // no disconnect event fired (silent broker drop). Invalidate our
        // belief so the NEXT publish attempts a fresh connect instead of
        // reusing a dead session forever.
        if (isRetryablePublishError(err)) {
          state.connected = false;
        }
        throw err;
      }
    },

    async disconnect(): Promise<void> {
      if (state.connected) {
        await state.producer.disconnect();
        state.connected = false;
      }
    },

    isConnected(): boolean {
      return state.connected;
    },

    async healthCheck(): Promise<KafkaHealth> {
      try {
        const admin = state.kafka.admin();
        await admin.connect();
        const [cluster, metadata] = await Promise.all([
          admin.describeCluster(),
          admin.fetchTopicMetadata({ topics: [] }),
        ]);
        await admin.disconnect();
        return {
          connected: state.connected,
          clientId,
          metadata: {
            brokers: cluster.brokers.length,
            topics: metadata.topics.map((t) => t.name),
          },
        };
      } catch (err) {
        return {
          connected: false,
          clientId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// getKafkaProducer("job-service")
//         ↓
// Kafka instance + Producer ဖန်တီး
//         ↓
// connect()
//         ↓
// Kafka broker ဆီ connection ချိတ်
//         ↓
// publish(topic, message)
//         ↓
// Message ကို EventEnvelope ထဲထည့်
//         ↓
// Kafka topic ထဲပို့
//         ↓
// healthCheck() / disconnect()