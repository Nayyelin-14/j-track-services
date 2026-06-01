import { Kafka, Consumer } from "kafkajs";
import { sql } from "@jtrack/shared/db";
import type { JobAppliedEvent } from "@jtrack/shared/kafka/events";
import type { KafkaHealth, ConsumerInstance } from "@jtrack/shared/kafka/types";
import { resolveKafkaConfig, checkKafkaHealth } from "@jtrack/shared";
import { createTransporter, sendWithRetry } from "./mail.js";

function newApplicationTemplate(applicantName: string, jobTitle: string, companyName: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>New Application Received</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#10b981,#059669);padding:40px 30px;text-align:center;">
              <div style="width:70px;height:70px;line-height:70px;margin:0 auto 20px;background-color:rgba(255,255,255,0.15);border-radius:50%;font-size:32px;">📋</div>
              <h1 style="margin:0;color:#ffffff;font-size:30px;font-weight:bold;">New Application</h1>
              <p style="margin-top:12px;color:rgba(255,255,255,0.9);font-size:16px;">${companyName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 35px;">
              <p style="margin-top:0;font-size:16px;color:#0f172a;line-height:1.7;">Hi there,</p>
              <p style="font-size:16px;color:#475569;line-height:1.8;">
                <strong>${applicantName}</strong> has applied for the position of
                <strong>${jobTitle}</strong> at <strong>${companyName}</strong>.
              </p>
              <div style="margin:30px 0;padding:24px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;text-align:center;">
                <p style="margin:0;color:#64748b;font-size:15px;line-height:1.8;">
                  Log in to <strong style="color:#3b82f6;">j-track</strong> to review the application and update its status.
                </p>
              </div>
              <p style="margin-top:35px;font-size:15px;color:#0f172a;line-height:1.7;">
                Best regards,<br/>
                <strong>j-track</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:20px;text-align:center;color:#94a3b8;font-size:13px;">
              <p style="margin:0;">© ${new Date().getFullYear()} j-track. All rights reserved.</p>
              <p style="margin:4px 0 0;">This is an automated notification. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function createNotificationConsumer(): ConsumerInstance {
  let consumer: Consumer | null = null;
  let running = false;

  return {
    async start() {
      if (running) return;

      const kafka = new Kafka(resolveKafkaConfig("notification-service"));
      consumer = kafka.consumer({
        groupId: process.env.KAFKA_NOTIFICATION_GROUP || "notification-group",
      });

      await consumer.connect();
      await consumer.subscribe({
        topic: process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events",
        fromBeginning: false,
      });

      const transporter = createTransporter();
      running = true;
      console.log(`[Notification Consumer] Started, listening on "${process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events"}"`);

      await consumer.run({
        eachMessage: async ({ message }) => {
          const rawValue = message.value?.toString();
          if (!rawValue) return;

          let event: { type: string };
          try {
            event = JSON.parse(rawValue);
          } catch {
            console.warn("[Notification Consumer] Invalid JSON, skipping");
            return;
          }

          if (event.type !== "job.applied") return;

          const { job_id, applicant_id } = event as JobAppliedEvent;

          try {
            const [job] = await sql`
              SELECT j.title, c.name AS company_name, c.recruiter_id
              FROM jobs j
              INNER JOIN companies c ON j.company_id = c.company_id
              WHERE j.job_id = ${job_id}
              LIMIT 1
            `;

            if (!job) {
              console.warn(`[Notification Consumer] Job ${job_id} not found, skipping`);
              return;
            }

            const [recruiter] = await sql`
              SELECT email FROM users WHERE user_id = ${job.recruiter_id} LIMIT 1
            `;

            if (!recruiter) {
              console.warn(`[Notification Consumer] Recruiter ${job.recruiter_id} not found, skipping`);
              return;
            }

            const [applicant] = await sql`
              SELECT name FROM users WHERE user_id = ${applicant_id} LIMIT 1
            `;

            const applicantName = applicant?.name || `User #${applicant_id}`;

            await sendWithRetry(transporter, {
              from: process.env.MAIL_USER,
              to: recruiter.email,
              subject: `New Application: ${job.title} at ${job.company_name}`,
              html: newApplicationTemplate(applicantName, job.title, job.company_name),
            }, "Notification");

            console.log(`[Notification] Sent new application alert to recruiter ${recruiter.email} for job ${job_id}`);
          } catch (err) {
            console.error(`[Notification Consumer] Failed to process job.applied event for job ${job_id}:`, err);
          }
        },
      });
    },

    async stop() {
      if (!running || !consumer) return;
      running = false;
      console.log("[Notification Consumer] Stopping...");
      await consumer.stop();
      await consumer.disconnect();
      consumer = null;
      console.log("[Notification Consumer] Stopped");
    },

    isRunning(): boolean {
      return running;
    },

    healthCheck(): Promise<KafkaHealth> {
      return checkKafkaHealth("notification-service", consumer !== null && running);
    },
  };
}
