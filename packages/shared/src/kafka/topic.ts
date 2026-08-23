import { Kafka } from "kafkajs";
import { resolveKafkaConfig } from "./config";

async function getAdmin(): Promise<ReturnType<Kafka["admin"]>> {
  const kafka = new Kafka(resolveKafkaConfig("topic-admin"));
  const admin = kafka.admin();
  await admin.connect();
  return admin;
}

/**
 * Ensure a topic exists, creating it with the configured partition count when
 * missing.
 *
 * replicationFactor is intentionally OMITTED unless KAFKA_TOPIC_REPLICATION_FACTOR
 * is explicitly set: KafkaJS then lets the broker apply its own default. This
 * is required for managed platforms (e.g. Confluent Cloud) where the cluster's
 * replication factor is platform-controlled and a topic creation that requests
 * a different RF is rejected (and for single-broker dev/CI clusters that cannot
 * satisfy RF > 1). Defaulting to a hardcoded 3 here was a latent startup bug.
 */
export async function ensureTopic(topic: string): Promise<void> {
  const admin = await getAdmin();

  try {
    const topics = await admin.listTopics();
    if (topics.includes(topic)) return;

    const partitions = Number(process.env.KAFKA_TOPIC_PARTITIONS) || 3;
    const replication = Number(process.env.KAFKA_TOPIC_REPLICATION_FACTOR);

    const topicConfig: { topic: string; numPartitions: number; replicationFactor?: number } = {
      topic,
      numPartitions: partitions,
    };
    if (replication > 0) {
      topicConfig.replicationFactor = replication;
    }

    await admin.createTopics({ topics: [topicConfig] });

    // createTopics may resolve even if the topic is not yet visible (or the
    // admin key lacks CREATE and the topic already exists). Confirm before
    // declaring success so startup does not silently proceed on a missing topic.
    const after = await admin.listTopics();
    if (!after.includes(topic)) {
      throw new Error(
        `Topic ${topic} not visible after createTopics (check Kafka admin ACLs: CREATE on the topic / cluster)`,
      );
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