import nodemailer from "nodemailer";
import { Kafka } from "kafkajs";
import { sleep, resolveKafkaConfig } from "@jtrack/shared/kafka/config";

export function createTransporter() {
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

export async function sendWithRetry(
  transporter: nodemailer.Transporter,
  mailOptions: nodemailer.SendMailOptions,
  label: string,
  retries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return;
    } catch (error) {
      console.error(`[${label}] Attempt ${attempt}/${retries} failed:`, error);
      if (attempt === retries) throw error;
      await sleep(1000 * attempt);
    }
  }
}

export async function publishToDLQ(kafka: Kafka, topic: string, message: string, reason: string) {
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
