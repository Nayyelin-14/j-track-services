import { Kafka } from "kafkajs";
import { resolveKafkaConfig } from "./config";

async function getAdmin(): Promise<ReturnType<Kafka["admin"]>> {
  const kafka = new Kafka(resolveKafkaConfig("topic-admin"));
  const admin = kafka.admin();
  await admin.connect();
  return admin;
}

export async function ensureTopic(topic: string): Promise<void> {
  const admin = await getAdmin();

  try {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) {
      const partitions = Number(process.env.KAFKA_TOPIC_PARTITIONS) || 3;
      const replication = Number(process.env.KAFKA_TOPIC_REPLICATION_FACTOR) || 1;
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
