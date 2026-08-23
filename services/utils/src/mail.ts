import nodemailer from "nodemailer";
import { sleep } from "@jtrack/shared/kafka/config";

export function mailDeliveryEnabled(): boolean {
  if (process.env["MAIL_SEND_ENABLED"] === "true") return true;
  if (process.env["MAIL_PREVIEW"] === "true") return false;
  return process.env["NODE_ENV"] === "production";
}

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
  if (!mailDeliveryEnabled()) {
    console.log(
      `[${label}] Mail delivery disabled — preview only. to=${mailOptions.to} subject=${mailOptions.subject}`,
    );
    return;
  }

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
