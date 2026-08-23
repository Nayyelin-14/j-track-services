export { prisma } from "./db";
export { signAccessToken, signRefreshToken, signResetToken } from "./token";
export { accessCookieOptions, refreshCookieOptions } from "./cookies";
export { getBuffer } from "./buffer";
export { ErrorHandler, errorMiddleware } from "./errorHandler";
export { TryCatch } from "./tryCatch";
export { isAuthenticated } from "./isauthenticated";
export { getKafkaProducer } from "./kafka/producer";
export { ensureTopic, listTopics } from "./kafka/topic";
export {
  enqueueOutboxEvent,
  claimOutboxBatch,
  processClaimed,
  sweepStaleClaims,
  startOutboxWorker,
  newEventId,
  isRetryablePublishError,
  retryDelayMs,
  findOutboxEvents,
  resetOutboxEvents,
} from "./kafka/outbox";
export type {
  OutboxEnqueueInput,
  OutboxWorker,
  OutboxWorkerOptions,
  OutboxQuery,
  OutboxResetInput,
} from "./kafka/outbox";
export { resolveKafkaConfig, sleep } from "./kafka/config";
export { checkKafkaHealth, getConsumerLag } from "./kafka/consumer";
export type { ConsumerLag, ConsumerLagResult } from "./kafka/types";
export {
  EVENT_VALIDATORS,
  validateEventEnvelope,
} from "./kafka/validation";
export type {
  EventValidator,
  ValidationFailure,
} from "./kafka/validation";
export { createConsumer } from "./kafka/consumer-factory";
export type { CreateConsumerOptions, ConsumerContext } from "./kafka/consumer-factory";
export type {
  MailMessage, KafkaHealth, ProducerInstance, PublishOptions,
} from "./kafka/types";
export {
  wrapInEnvelope,
  normalizeKafkaMessage,
  isEnvelope,
} from "./kafka/envelope";
export type {
  EventEnvelope,
  EnvelopeInput,
  NormalizedMessage,
} from "./kafka/envelope";
export {
  markProcessed,
  markProcessedInTx,
  isAlreadyProcessed,
  pruneProcessedRecords,
} from "./kafka/idempotency";
export type { DedupRecord, DedupRecordInput } from "./kafka/idempotency";
export {
  KafkaMetrics,
  getMetrics,
} from "./kafka/metrics";
export type { MetricsSnapshot } from "./kafka/metrics";
export {
  isRetryableError,
  NonRetryableError,
  runWithRetryAndDlq,
  publishToDLQ,
  computeRetryDelayMs,
} from "./kafka/dlq";
export type { DlqRecord, RetryPolicy } from "./kafka/dlq";
export {
  runWithCorrelation,
  runWithCorrelationSync,
  getCorrelationId,
  currentCorrelationId,
  newCorrelationId,
  correlationMiddleware,
} from "./kafka/correlation";
export { replayFromDlq, parseDlqMessage } from "./kafka/replay";
export type { DlqMessage, ReplayOptions, ReplayResult } from "./kafka/replay";
export {
  producePartitionKey,
  jobPartitionKey,
  applicantPartitionKey,
} from "./kafka/partitioning";
export { createRedisHelpers, withCache } from "./redis/helpers";
export type { RedisClient } from "./redis/helpers";
export type { AuthRequest, UserPayload } from "./types";
export type {
  JobEvent,
  JobViewedEvent,
  JobAppliedEvent,
  ApplicationStatusChangedEvent,
  JobEventEnvelope,
  JobViewedEnvelope,
  JobAppliedEnvelope,
  ApplicationStatusChangedEnvelope,
} from "./kafka/events";
