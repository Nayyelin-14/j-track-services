import { Kafka } from "kafkajs";
import type { KafkaHealth, ConsumerLag, ConsumerLagResult } from "./types";
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

/**
 * Real Kafka consumer lag for a group: for each topic/partition of `topics`,
 * lag = log-end offset (high watermark) minus the group's committed offset.
 *
 * Edge cases:
 * - No committed offset (fresh group / never-committed partition): the broker
 *   returns -1; `hasCommittedOffset` is false and `lag` is the full partition
 *   length (an UPPER BOUND, not a true "behind" measure).
 * - Empty partition: end offset 0 -> lag 0.
 * - A disconnected consumer: committed offsets still live on the broker, so
 *   lag reflects reality regardless of the consumer's own connection.
 *
 * This is broker-truth, not an in-process approximation. Requires the Kafka
 * admin connection to have DESCRIBE on the topics and READ on the consumer
 * group. Returns undefined when the broker cannot be reached or the query
 * fails (a lag outage should degrade observability, not crash the caller).
 */
export async function getConsumerLag(
  clientId: string,
  groupId: string,
  topics: string[],
): Promise<ConsumerLagResult | undefined> {
  try {
    const admin = new Kafka(resolveKafkaConfig(`lag-${clientId}`)).admin();
    await admin.connect();

    const [committed, endOffsets] = await Promise.all([
      admin.fetchOffsets({ groupId, topics }),
      Promise.all(
        topics.map(async (topic) => ({
          topic,
          partitions: await admin.fetchTopicOffsets(topic),
        })),
      ),
    ]);

    await admin.disconnect();

    const committedMap = new Map<string, Map<number, number>>();
    for (const t of committed) {
      const m = new Map<number, number>();
      for (const p of t.partitions) m.set(p.partition, Number(p.offset));
      committedMap.set(t.topic, m);
    }

    const rows: ConsumerLag[] = [];
    for (const { topic, partitions } of endOffsets) {
      for (const p of partitions) {
        const endOffset = Math.max(Number(p.offset), 0);
        const rawCommitted = committedMap.get(topic)?.get(p.partition) ?? -1;
        const hasCommittedOffset = rawCommitted !== -1;
        const committedOffset = Math.max(rawCommitted, 0);
        rows.push({
          topic,
          partition: p.partition,
          committedOffset,
          endOffset,
          // With no committed offset the lag is the full partition length
          // (conservative upper bound; the consumer may not have started).
          lag: Math.max(0, endOffset - committedOffset),
          hasCommittedOffset,
        });
      }
    }

    return {
      groupId,
      topics: rows,
      totalLag: rows.reduce((sum, r) => sum + r.lag, 0),
    };
  } catch {
    return undefined;
  }
}