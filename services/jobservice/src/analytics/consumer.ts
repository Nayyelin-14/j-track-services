import { prisma } from "@jtrack/shared/db";
import { createConsumer } from "@jtrack/shared/kafka/consumer-factory";
import { markProcessedInTx } from "@jtrack/shared/kafka/idempotency";
import { getMetrics } from "@jtrack/shared/kafka/metrics";
import type { JobEvent } from "@jtrack/shared/kafka/events";

function isJobEvent(event: JobEvent): boolean {
  return (
    event?.type === "job.viewed" ||
    event?.type === "job.applied" ||
    event?.type === "application.status_changed"
  );
}

function jobEventToDelta(event: JobEvent): {
  job_id: number;
  date: string;
  views: number;
  applications: number;
  status_changes: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  switch (event.type) {
    case "job.viewed":
      return { job_id: event.job_id, date: today, views: 1, applications: 0, status_changes: 0 };
    case "job.applied":
      return { job_id: event.job_id, date: today, views: 0, applications: 1, status_changes: 0 };
    case "application.status_changed":
      return { job_id: event.job_id, date: today, views: 0, applications: 0, status_changes: 1 };
  }
}

const CONSUMER_ID = "job-analytics";

export function createAnalyticsConsumer() {
  return createConsumer({
    clientId: "job-analytics",
    groupId: process.env.KAFKA_ANALYTICS_GROUP || "job-analytics-group",
    consumerId: CONSUMER_ID,
    topics: [process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events"],
    dlqTopic: process.env.KAFKA_ANALYTICS_DLQ_TOPIC || "job-events-dlq",
    shouldProcess: (envelope) => {
      const payload = envelope.payload as JobEvent;
      return isJobEvent(payload);
    },
    handler: async (ctx) => {
      const payload = ctx.envelope.payload as JobEvent;

      const delta = jobEventToDelta(payload);
      if (!delta) return;

      // Transactional idempotency: the dedup record and the analytics upsert
      // commit atomically. A redelivered eventId hits the unique
      // (consumerId, eventId) constraint inside the same transaction, which
      // then rolls back (no double-count) and reports duplicate.
      const result = await prisma.$transaction(async (tx) => {
        const dedup = await markProcessedInTx(tx, {
          consumerId: CONSUMER_ID,
          envelope: ctx.envelope,
          partition: ctx.partition,
          offset: ctx.offset,
        });

        if (dedup.isDuplicate) {
          return { duplicate: true as const };
        }

        await tx.jobAnalytics.upsert({
          where: {
            job_id_date: {
              job_id: delta.job_id,
              date: new Date(delta.date),
            },
          },
          create: {
            job_id: delta.job_id,
            date: new Date(delta.date),
            views: delta.views,
            applications: delta.applications,
            status_changes: delta.status_changes,
          },
          update: {
            views: { increment: delta.views },
            applications: { increment: delta.applications },
            status_changes: { increment: delta.status_changes },
          },
        });

        return { duplicate: false as const };
      });

      if (result.duplicate) {
        getMetrics(CONSUMER_ID).recordDeduped();
        ctx.log("info", "Duplicate eventId skipped", {
          eventId: ctx.envelope.eventId,
          correlationId: ctx.envelope.correlationId,
        });
      }
    },
    log: (level, msg, meta) => {
      const prefix = "[Analytics Consumer]";
      if (level === "error") console.error(prefix, msg, meta ?? {});
      else if (level === "warn") console.warn(prefix, msg, meta ?? {});
      else console.log(prefix, msg, meta ?? {});
    },
  });
}
