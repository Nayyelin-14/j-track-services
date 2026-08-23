-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "topic" VARCHAR(255) NOT NULL,
    "partitionKey" VARCHAR(255),
    "source" VARCHAR(100) NOT NULL,
    "correlationId" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" VARCHAR(100),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_events_eventType_idx" ON "outbox_events"("eventType");