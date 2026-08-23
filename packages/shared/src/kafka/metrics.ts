export interface MetricsSnapshot {
  clientId: string;
  /** Messages whose handler completed successfully (exactly-once business effect applied). */
  processed: number;
  /** Messages whose handler failed permanently (DLQ'd or DLQ-write failed). */
  failed: number;
  /** Extra handler retry attempts after the first (backoff attempts). */
  retries: number;
  /** Records successfully written to the DLQ. */
  dlq: number;
  /** Messages the DLQ write failed for (offset NOT committed; redelivered on restart). */
  dlqFailed: number;
  /** Messages skipped as duplicates via consumer_dedup idempotency. */
  deduped: number;
  totalProcessingMs: number;
  outboxPending: number;
  outboxFailed: number;
  startedAt: string;
}

/**
 * Lightweight in-process Kafka metrics counters. No external dependency by
 * design (the approved architecture defers Prometheus/OTel). Counters are
 * bumped by shared consumer/producer helpers and surfaced via structured logs
 * and health endpoints.
 *
 * Semantics:
 * - `processed` and `failed` are event-level outcomes (a message is one or the
 *   other once its handling terminates).
 * - `dlq` and `dlqFailed` are channel-level: a failed event produces exactly
 *   one of them (it either reached the DLQ or did not). A DLQ'd event therefore
 *   increments BOTH `failed` and `dlq` - they measure different things.
 * - `retries` counts handler retry attempts beyond the first.
 * - `deduped` counts duplicate `eventId` deliveries that were skipped.
 */
export class KafkaMetrics {
  private processed = 0;
  private failed = 0;
  private retries = 0;
  private dlq = 0;
  private dlqFailed = 0;
  private deduped = 0;
  private totalProcessingMs = 0;
  private outboxPending = 0;
  private outboxFailed = 0;
  private startedAt = new Date().toISOString();

  constructor(private clientId: string) {}

  recordProcessed(durationMs?: number): this {
    this.processed++;
    if (durationMs !== undefined) {
      this.totalProcessingMs += durationMs;
    }
    return this;
  }

  recordFailed(): this {
    this.failed++;
    return this;
  }

  recordRetry(): this {
    this.retries++;
    return this;
  }

  recordDlq(): this {
    this.dlq++;
    return this;
  }

  recordDlqFailed(): this {
    this.dlqFailed++;
    return this;
  }

  recordDeduped(): this {
    this.deduped++;
    return this;
  }

  setOutboxCounts(pending: number, failed: number): this {
    this.outboxPending = pending;
    this.outboxFailed = failed;
    return this;
  }

  snapshot(): MetricsSnapshot {
    return {
      clientId: this.clientId,
      processed: this.processed,
      failed: this.failed,
      retries: this.retries,
      dlq: this.dlq,
      dlqFailed: this.dlqFailed,
      deduped: this.deduped,
      totalProcessingMs: this.totalProcessingMs,
      outboxPending: this.outboxPending,
      outboxFailed: this.outboxFailed,
      startedAt: this.startedAt,
    };
  }
}

const metrics = new Map<string, KafkaMetrics>();

export function getMetrics(clientId: string): KafkaMetrics {
  let m = metrics.get(clientId);
  if (!m) {
    m = new KafkaMetrics(clientId);
    metrics.set(clientId, m);
  }
  return m;
}