import { Kafka } from "kafkajs";
import type { KafkaHealth } from "./types";
import { resolveKafkaConfig } from "./config";

export async function checkKafkaHealth(clientId: string, isConnected: boolean): Promise<KafkaHealth> {
  try {
    const admin = new Kafka(resolveKafkaConfig(`health-check-${clientId}`)).admin();
    await admin.connect();
    const [cluster, metadata] = await Promise.all([
      admin.describeCluster(),
      admin.fetchTopicMetadata({ topics: [] }),
    ]);
    await admin.disconnect();
    return {
      connected: isConnected,
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
}
