import { Kafka, Consumer } from "kafkajs";
import nodemailer from "nodemailer";
import type { KafkaHealth, ConsumerInstance } from "@jtrack/shared/kafka/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type KafkaConfig = ConstructorParameters<typeof Kafka>[0];

function resolveConfig(clientId: string): KafkaConfig {
  const config: KafkaConfig = {
    clientId,
    brokers: (process.env.KAFKA_BROKER || "localhost:9092").split(",").map((b) => b.trim()),
    connectionTimeout: Number(process.env.KAFKA_CONNECTION_TIMEOUT) || 10000,
    authenticationTimeout: Number(process.env.KAFKA_AUTH_TIMEOUT) || 10000,
    retry: {
      initialRetryTime: Number(process.env.KAFKA_RETRY_INITIAL_TIME) || 300,
      retries: Number(process.env.KAFKA_RETRY_COUNT) || 10,
    },
  };

  const saslMechanism = process.env.KAFKA_SASL_MECHANISM;
  const saslUsername = process.env.KAFKA_SASL_USERNAME;
  const saslPassword = process.env.KAFKA_SASL_PASSWORD;
  if (saslMechanism && saslUsername && saslPassword) {
    config.sasl = { mechanism: saslMechanism, username: saslUsername, password: saslPassword } as any;
    config.ssl = true;
  } else if (process.env.KAFKA_SSL === "true") {
    config.ssl = true;
  }

  return config;
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== "false",
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
}

async function sendWithRetry(
  transporter: nodemailer.Transporter,
  mailOptions: nodemailer.SendMailOptions,
  retries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return;
    } catch (error) {
      console.error(`[Mail] Attempt ${attempt}/${retries} failed:`, error);
      if (attempt === retries) throw error;
      await sleep(1000 * attempt);
    }
  }
}

export function createMailConsumer(): ConsumerInstance {
  let consumer: Consumer | null = null;
  let running = false;

  return {
    async start() {
      if (running) return;

      const kafka = new Kafka(resolveConfig("mail-service"));
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
        eachMessage: async ({ topic: originTopic, message, heartbeat }) => {
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
            }, maxRetries);
            console.log(`[Mail] Sent to ${parsed.to}`);
          } catch (err) {
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

    async healthCheck(): Promise<KafkaHealth> {
      try {
        if (consumer) {
          const admin = new Kafka(resolveConfig("health-check")).admin();
          await admin.connect();
          const [cluster, metadata] = await Promise.all([
            admin.describeCluster(),
            admin.fetchTopicMetadata({ topics: [] }),
          ]);
          await admin.disconnect();
          return {
            connected: running,
            clientId: "mail-service",
            metadata: {
              brokers: cluster.brokers.length,
              topics: metadata.topics.map((t) => t.name),
            },
          };
        }
        return { connected: false, clientId: "mail-service", error: "Consumer not initialized" };
      } catch (err) {
        return {
          connected: false,
          clientId: "mail-service",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

async function publishToDLQ(kafka: Kafka, topic: string, message: string, reason: string) {
  const dlqProducer = kafka.producer();
  try {
    await dlqProducer.connect();
    await dlqProducer.send({
      topic,
      messages: [{
        value: JSON.stringify({ originalMessage: message, failureReason: reason, timestamp: new Date().toISOString() }),
      }],
    });
  } catch (err) {
    console.error(`[DLQ] Failed to publish to ${topic}:`, err);
  } finally {
    await dlqProducer.disconnect();
  }
}
