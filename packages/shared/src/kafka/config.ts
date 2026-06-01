import { Kafka } from "kafkajs";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type KafkaConfig = ConstructorParameters<typeof Kafka>[0];

export function resolveKafkaConfig(clientId: string): KafkaConfig {
  const config: KafkaConfig = {
    clientId,
    brokers: (process.env.KAFKA_BROKER || "localhost:9092").split(",").map((b) => b.trim()),
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
    config.sasl = { mechanism: saslMechanism, username: saslUsername, password: saslPassword } as never;
    config.ssl = true;
  } else if (process.env.KAFKA_SSL === "true") {
    config.ssl = true;
  }

  return config;
}
