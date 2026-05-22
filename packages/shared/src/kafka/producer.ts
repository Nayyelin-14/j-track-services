import { Kafka, Producer } from "kafkajs";
import { MailMessage, ProducerInstance, KafkaHealth } from "./types";

const REGISTRY = new Map<string, { kafka: Kafka; producer: Producer; connected: boolean }>();
const PENDING_CONNECTIONS = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveBrokers(): string[] {
  return (process.env.KAFKA_BROKER || "localhost:9092").split(",").map((b) => b.trim());
}

type KafkaConfig = ConstructorParameters<typeof Kafka>[0];

function buildConfig(clientId: string): KafkaConfig {
  const config: KafkaConfig = {
    clientId,
    brokers: resolveBrokers(),
    connectionTimeout: Number(process.env.KAFKA_CONNECTION_TIMEOUT) || 10000,
    authenticationTimeout: Number(process.env.KAFKA_AUTH_TIMEOUT) || 10000,
    retry: {
      initialRetryTime: Number(process.env.KAFKA_RETRY_INITIAL_TIME) || 300,
      retries: Number(process.env.KAFKA_RETRY_COUNT) || 10,
    },
  };

  const saslMechanism = process.env.KAFKA_SASL_MECHANISM;
  const saslUsername = process.env.KAFKA_SASL_USERNAME;
  const saslPassword = process.env.KAFKA_SASL_PASSWORD;
  if (saslMechanism && saslUsername && saslPassword) {
    config.sasl = { mechanism: saslMechanism, username: saslUsername, password: saslPassword } as any;
    config.ssl = true;
  } else if (process.env.KAFKA_SSL === "true") {
    config.ssl = true;
  }

  return config;
}

async function connectWithBackoff(producer: Producer, maxRetries = 5): Promise<void> {
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

export function getKafkaProducer(clientId: string): ProducerInstance {
  const existing = REGISTRY.get(clientId);
  if (existing) {
    return buildInterface(clientId, existing);
  }

  const config = buildConfig(clientId);
  const kafka = new Kafka(config);
  const producer = kafka.producer();
  const state = { kafka, producer, connected: false };
  REGISTRY.set(clientId, state);
  return buildInterface(clientId, state);
}

function buildInterface(clientId: string, state: { kafka: Kafka; producer: Producer; connected: boolean }): ProducerInstance {
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

    async publish(topic: string, message: MailMessage): Promise<void> {
      if (!state.connected) {
        throw new Error("Kafka producer not connected. Call connect() first.");
      }
      await state.producer.send({
        topic,
        messages: [{ value: JSON.stringify(message) }],
      });
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
