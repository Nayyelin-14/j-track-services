-- Drop the orphaned experimental table created by migration 20260617000000_add_outbox_and_processed_events
-- which was never committed to the repo and is referenced by no code.
DROP TABLE IF EXISTS "processed_events";

-- CreateTable
CREATE TABLE "consumer_dedup" (
    "id" BIGSERIAL NOT NULL,
    "consumerId" VARCHAR(100) NOT NULL,
    "eventId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL,
    "processedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurredAt" TIMESTAMPTZ(6),

    CONSTRAINT "consumer_dedup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consumer_dedup_consumerId_eventId_key" ON "consumer_dedup"("consumerId", "eventId");

-- CreateIndex
CREATE INDEX "consumer_dedup_processedAt_idx" ON "consumer_dedup"("processedAt");