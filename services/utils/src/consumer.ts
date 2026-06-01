import { Kafka, Consumer } from "kafkajs";
import type { KafkaHealth, ConsumerInstance } from "@jtrack/shared/kafka/types";
import { resolveKafkaConfig, checkKafkaHealth } from "@jtrack/shared";
import { createTransporter, sendWithRetry, publishToDLQ } from "./mail.js";

export function createMailConsumer(): ConsumerInstance {
  let consumer: Consumer | null = null;
  let running = false;

  return {
    async start() {
      if (running) return;

      const kafka = new Kafka(resolveKafkaConfig("mail-service"));
      consumer = kafka.consumer({ groupId: process.env.KAFKA_CONSUMER_GROUP || "mail-service-group" });

      await consumer.connect();
      await consumer.subscribe({
        topic: process.env.KAFKA_MAIL_TOPIC || "send-mail",
        fromBeginning: false,
      });

      const transporter = createTransporter();
      const dlqTopic = process.env.KAFKA_DLQ_TOPIC || "send-mail-dlq";
      const maxRetries = Number(process.env.MAIL_SEND_RETRIES) || 3;

      running = true;
      console.log(`[Mail Consumer] Started, listening on "${process.env.KAFKA_MAIL_TOPIC || "send-mail"}"`);

      await consumer.run({
        eachMessage: async ({ message }) => {
          const rawValue = message.value?.toString();
          if (!rawValue) {
            console.warn("[Mail Consumer] Received empty message, skipping");
            return;
          }

          let parsed: { to?: string; subject?: string; html?: string };
          try {
            parsed = JSON.parse(rawValue);
          } catch {
            console.error("[Mail Consumer] Invalid JSON message, publishing to DLQ");
            await publishToDLQ(kafka, dlqTopic, rawValue, "parse_error");
            return;
          }

          if (!parsed.to || !parsed.subject || !parsed.html) {
            console.error("[Mail Consumer] Missing required fields, publishing to DLQ", parsed);
            await publishToDLQ(kafka, dlqTopic, rawValue, "missing_fields");
            return;
          }

          try {
            await sendWithRetry(transporter, {
              from: process.env.MAIL_USER,
              to: parsed.to,
              subject: parsed.subject,
              html: parsed.html,
            }, "Mail", maxRetries);
            console.log(`[Mail] Sent to ${parsed.to}`);
          } catch {
            console.error(`[Mail] All attempts failed for ${parsed.to}, publishing to DLQ`);
            await publishToDLQ(kafka, dlqTopic, rawValue, "send_failed");
          }
        },
      });
    },

    async stop() {
      if (!running || !consumer) return;
      running = false;
      console.log("[Mail Consumer] Stopping...");
      await consumer.stop();
      await consumer.disconnect();
      consumer = null;
      console.log("[Mail Consumer] Stopped");
    },

    isRunning(): boolean {
      return running;
    },

    healthCheck(): Promise<KafkaHealth> {
      return checkKafkaHealth("mail-service", consumer !== null && running);
    },
  };
}
