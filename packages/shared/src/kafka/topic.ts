import { Kafka } from "kafkajs";

function resolveBrokers(): string[] {
  return (process.env.KAFKA_BROKER || "localhost:9092")
    .split(",")
    .map((b) => b.trim());
}

type KafkaConfig = ConstructorParameters<typeof Kafka>[0];

function buildConfig(): KafkaConfig {
  const config: KafkaConfig = {
    clientId: "topic-admin",
    brokers: resolveBrokers(),
    connectionTimeout: Number(process.env.KAFKA_CONNECTION_TIMEOUT) || 10000,
    authenticationTimeout: Number(process.env.KAFKA_AUTH_TIMEOUT) || 10000,
    retry: {
      initialRetryTime: Number(process.env.KAFKA_RETRY_INITIAL_TIME) || 300,
      retries: Number(process.env.KAFKA_RETRY_COUNT) || 5,
    },
  };

  const saslMechanism = process.env.KAFKA_SASL_MECHANISM;
  const saslUsername = process.env.KAFKA_SASL_USERNAME;
  const saslPassword = process.env.KAFKA_SASL_PASSWORD;
  if (saslMechanism && saslUsername && saslPassword) {
    config.sasl = {
      mechanism: saslMechanism,
      username: saslUsername,
      password: saslPassword,
    } as any;
    config.ssl = true;
  } else if (process.env.KAFKA_SSL === "true") {
    config.ssl = true;
  }

  return config;
}

async function getAdmin(): Promise<ReturnType<Kafka["admin"]>> {
  const kafka = new Kafka(buildConfig());
  console.log("admin created 1 ", kafka);
  const admin = kafka.admin();
  console.log("admin created 2 ", admin);
  await admin.connect();
  return admin;
}

export async function ensureTopic(topic: string): Promise<void> {
  const admin = await getAdmin();
  console.log("admin created 3 ", admin);

  try {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) {
      const partitions = Number(process.env.KAFKA_TOPIC_PARTITIONS) || 3;
      const replication =
        Number(process.env.KAFKA_TOPIC_REPLICATION_FACTOR) || 1;
      await admin.createTopics({
        topics: [
          { topic, numPartitions: partitions, replicationFactor: replication },
        ],
      });
    }
  } finally {
    await admin.disconnect();
  }
}

export async function listTopics(): Promise<string[]> {
  const admin = await getAdmin();
  try {
    return await admin.listTopics();
  } finally {
    await admin.disconnect();
  }
}

export async function deleteTopic(topic: string): Promise<void> {
  const admin = await getAdmin();
  try {
    await admin.deleteTopics({ topics: [topic] });
  } finally {
    await admin.disconnect();
  }
}
