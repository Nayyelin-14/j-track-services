import { prisma } from "@jtrack/shared/db";
import { createConsumer } from "@jtrack/shared/kafka/consumer-factory";
import {
  isAlreadyProcessed,
  markProcessed,
} from "@jtrack/shared/kafka/idempotency";
import { getMetrics } from "@jtrack/shared/kafka/metrics";
import { createTransporter, sendWithRetry, mailDeliveryEnabled } from "./mail.js";
import type { JobAppliedEvent } from "@jtrack/shared/kafka/events";

const CONSUMER_ID = "notification-service";

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

export function createNotificationConsumer() {
  const transporter = createTransporter();
  const maxRetries = Number(process.env.MAIL_SEND_RETRIES) || 3;

  return createConsumer({
    clientId: "notification-service",
    groupId: process.env.KAFKA_NOTIFICATION_GROUP || "notification-group",
    consumerId: CONSUMER_ID,
    topics: [process.env.KAFKA_JOB_EVENTS_TOPIC || "job-events"],
    dlqTopic: process.env.KAFKA_NOTIFICATION_DLQ_TOPIC || "job-events-dlq",
    shouldProcess: (envelope) => {
      const payload = envelope.payload as { type?: string };
      return payload?.type === "job.applied";
    },
    handler: async (ctx) => {
      const event = ctx.envelope.payload as JobAppliedEvent;

      // External SMTP effect: check-then-mark idempotency (at-least-once).
      if (await isAlreadyProcessed(prisma, CONSUMER_ID, ctx.envelope.eventId)) {
        getMetrics(CONSUMER_ID).recordDeduped();
        ctx.log("info", "Duplicate notification skipped", {
          eventId: ctx.envelope.eventId,
          correlationId: ctx.envelope.correlationId,
        });
        return;
      }

      const job = await prisma.job.findFirst({
        where: { job_id: event.job_id },
        select: {
          title: true,
          company: { select: { name: true, recruiter_id: true } },
        },
      });

      if (!job) {
        ctx.log("warn", `Job ${event.job_id} not found, marking processed`, {
          eventId: ctx.envelope.eventId,
        });
        await markProcessed(prisma, {
          consumerId: CONSUMER_ID,
          envelope: ctx.envelope,
          partition: ctx.partition,
          offset: ctx.offset,
        });
        return;
      }

      const recruiter = await prisma.user.findFirst({
        where: { user_id: job.company.recruiter_id },
        select: { email: true },
      });

      if (!recruiter) {
        ctx.log("warn", `Recruiter ${job.company.recruiter_id} not found, marking processed`, {
          eventId: ctx.envelope.eventId,
        });
        await markProcessed(prisma, {
          consumerId: CONSUMER_ID,
          envelope: ctx.envelope,
          partition: ctx.partition,
          offset: ctx.offset,
        });
        return;
      }

      const applicant = await prisma.user.findFirst({
        where: { user_id: event.applicant_id },
        select: { name: true },
      });
      const applicantName = applicant?.name || `User #${event.applicant_id}`;

      if (mailDeliveryEnabled()) {
        await sendWithRetry(
          transporter,
          {
            from: process.env.MAIL_USER,
            to: recruiter.email,
            subject: `New Application: ${job.title} at ${job.company.name}`,
            html: newApplicationTemplate(applicantName, job.title, job.company.name),
          },
          "Notification",
          maxRetries,
        );
      } else {
        ctx.log("info", "Mail delivery disabled - preview only", {
          to: recruiter.email,
        });
      }

      await markProcessed(prisma, {
        consumerId: CONSUMER_ID,
        envelope: ctx.envelope,
        partition: ctx.partition,
        offset: ctx.offset,
      });

      ctx.log("info", "Notification processed", {
        eventId: ctx.envelope.eventId,
        correlationId: ctx.envelope.correlationId,
        recruiter: recruiter.email,
        jobId: event.job_id,
      });
    },
    log: (level, msg, meta) => {
      const prefix = "[Notification Consumer]";
      if (level === "error") console.error(prefix, msg, meta ?? {});
      else if (level === "warn") console.warn(prefix, msg, meta ?? {});
      else console.log(prefix, msg, meta ?? {});
    },
  });
}
