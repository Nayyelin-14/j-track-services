/**
 * Partition-key derivation (Phase 7).
 *
 * Kafka orders messages *within a partition*. To guarantee ordering per
 * aggregate (e.g. all events about job 42 are processed in order), the message
 * key must be derived from the aggregate id, NOT from the event type or a
 * random value. This helper is the single source of truth for those keys.
 *
 * We deliberately do NOT claim global ordering across partitions.
 */
export function producePartitionKey(aggregate: "job" | "applicant", id: string | number): string {
  return `${aggregate}-${String(id)}`;
}

/** The current app set of keys produced by its business operations. */
export function jobPartitionKey(jobId: string | number): string {
  return producePartitionKey("job", jobId);
}

export function applicantPartitionKey(applicantId: string | number): string {
  return producePartitionKey("applicant", applicantId);
}