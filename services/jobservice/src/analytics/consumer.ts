import { Kafka, Consumer } from "kafkajs";
import { prisma } from "@jtrack/shared/db";
import type { JobEvent } from "@jtrack/shared/kafka/events";
import type { KafkaHealth } from "@jtrack/shared/kafka/types";
import { resolveKafkaConfig, checkKafkaHealth } from "@jtrack/shared";

function processEvent(event: JobEvent): { job_id: number; date: string; views: number; applications: number; status_changes: number } | null {
  const today = new Date().toISOString().slice(0, 10);

  switch (event.type) {
    case "job.viewed":
      return { job_id: event.job_id, date: today, views: 1, applications: 0, status_changes: 0 };
    case "job.applied":
      return { job_id: event.job_id, date: today, views: 0, applications: 1, status_changes: 0 };
    case "application.status_changed":
      return { job_id: event.job_id, date: today, views: 0, applications: 0, status_changes: 1 };
    default:
      return null;
  }
}

export function createAnalyticsConsumer() {
  let consumer: Consumer | null = null;
  let running = false;

  return {
    async start() {
      if (running) return;

      const kafka = new Kafka(resolveKafkaConfig("job-analytics"));
      consumer = kafka.consumer({
        groupId: process.env.KAFKA_ANALYTICS_GROUP || "job-analytics-group",
      });

      await consumer.connect();
      await consumer.subscribe({
        topic: process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events",
        fromBeginning: false,
      });

      running = true;
      console.log(`[Analytics Consumer] Started, listening on "${process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events"}"`);

      await consumer.run({
        eachMessage: async ({ message }) => {
          const rawValue = message.value?.toString();
          if (!rawValue) return;

          let event: JobEvent;
          try {
            event = JSON.parse(rawValue);
          } catch {
            console.warn("[Analytics Consumer] Invalid JSON, skipping");
            return;
          }

          const delta = processEvent(event);
          if (!delta) return;

          try {
            await prisma.jobAnalytics.upsert({
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
          } catch (err) {
            console.error(`[Analytics Consumer] DB upsert failed for job ${delta.job_id}:`, err);
          }
        },
      });
    },

    async stop() {
      if (!running || !consumer) return;
      running = false;
      console.log("[Analytics Consumer] Stopping...");
      await consumer.stop();
      await consumer.disconnect();
      consumer = null;
      console.log("[Analytics Consumer] Stopped");
    },

    isRunning(): boolean {
      return running;
    },

    healthCheck(): Promise<KafkaHealth> {
      return checkKafkaHealth("job-analytics", consumer !== null && running);
    },
  };
}
