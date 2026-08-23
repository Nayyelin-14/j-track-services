import { describe, it, expect } from "vitest";
import { getMetrics, KafkaMetrics } from "../metrics.js";

describe("metrics (Phase 9)", () => {
  it("tracks processed/failed/retries/dlq counters and duration", () => {
    const m = new KafkaMetrics("analytics");
    m.recordProcessed(12)
      .recordProcessed(8)
      .recordFailed()
      .recordRetry()
      .recordDlq()
      .recordDeduped();
    const snap = m.snapshot();
    expect(snap.processed).toBe(2);
    expect(snap.failed).toBe(1);
    expect(snap.retries).toBe(1);
    expect(snap.dlq).toBe(1);
    expect(snap.deduped).toBe(1);
    expect(snap.totalProcessingMs).toBe(20);
  });

  it("records dlqFailed separately from dlq (DLQ writes that themselves fail)", () => {
    const m = new KafkaMetrics("analytics");
    m.recordDlq();
    m.recordDlqFailed();
    m.recordDlqFailed();
    const snap = m.snapshot();
    expect(snap.dlq).toBe(1);
    expect(snap.dlqFailed).toBe(2);
  });

  it("includes outbox pending/failed counts for health surfaces", () => {
    const m = new KafkaMetrics("job-service-outbox");
    m.setOutboxCounts(5, 2);
    expect(m.snapshot().outboxPending).toBe(5);
    expect(m.snapshot().outboxFailed).toBe(2);
  });

  it("returns a singleton per clientId via getMetrics", () => {
    const a = getMetrics("shared-consumer");
    const b = getMetrics("shared-consumer");
    expect(a).toBe(b);
    a.recordProcessed();
    expect(b.snapshot().processed).toBe(1);
  });
});