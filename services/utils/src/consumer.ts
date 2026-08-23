import { createConsumer } from "@jtrack/shared/kafka/consumer-factory";
import { prisma } from "@jtrack/shared/db";
import {
  isAlreadyProcessed,
  markProcessed,
} from "@jtrack/shared/kafka/idempotency";
import { getMetrics } from "@jtrack/shared/kafka/metrics";
import { createTransporter, sendWithRetry, mailDeliveryEnabled } from "./mail.js";

interface MailPayload {
  to?: string;
  subject?: string;
  html?: string;
  from?: string;
}

const CONSUMER_ID = "mail-service";

export function createMailConsumer() {
  const transporter = createTransporter();
  const maxRetries = Number(process.env.MAIL_SEND_RETRIES) || 3;

  return createConsumer({
    clientId: "mail-service",
    groupId: process.env.KAFKA_CONSUMER_GROUP || "mail-service-group",
    consumerId: CONSUMER_ID,
    topics: [process.env.KAFKA_MAIL_TOPIC || "send-mail"],
    dlqTopic: process.env.KAFKA_DLQ_TOPIC || "send-mail-dlq",
    shouldProcess: (envelope) => {
      const payload = envelope.payload as MailPayload;
      return Boolean(payload.to && payload.subject && payload.html);
    },
    handler: async (ctx) => {
      const payload = ctx.envelope.payload as MailPayload;

      // External effect (SMTP) cannot be transactional with the dedup row.
      // Check-then-act: skip when already sent; mark only after the send
      // succeeds. A crash between send and mark leads to a re-send on
      // redelivery (at-least-once, accepted).
      if (await isAlreadyProcessed(prisma, CONSUMER_ID, ctx.envelope.eventId)) {
        getMetrics(CONSUMER_ID).recordDeduped();
        ctx.log("info", "Duplicate mail event skipped", {
          eventId: ctx.envelope.eventId,
          correlationId: ctx.envelope.correlationId,
          to: payload.to,
        });
        return;
      }

      if (mailDeliveryEnabled()) {
        await sendWithRetry(
          transporter,
          {
            from: payload.from ?? process.env.MAIL_USER,
            to: payload.to!,
            subject: payload.subject!,
            html: payload.html!,
          },
          "Mail",
          maxRetries,
        );
      } else {
        ctx.log("info", "Mail delivery disabled - preview only", {
          to: payload.to,
          subject: payload.subject,
        });
      }

      // Mark as processed regardless: in preview mode the "send" is a log, and
      // in real mode the send already succeeded (otherwise an exception was
      // thrown and we'd go through retry/DLQ). This prevents infinite
      // redelivery in both environments.
      await markProcessed(prisma, {
        consumerId: CONSUMER_ID,
        envelope: ctx.envelope,
        partition: ctx.partition,
        offset: ctx.offset,
      });

      ctx.log("info", "Mail processed", {
        eventId: ctx.envelope.eventId,
        correlationId: ctx.envelope.correlationId,
        to: payload.to,
      });
    },
    log: (level, msg, meta) => {
      const prefix = "[Mail Consumer]";
      if (level === "error") console.error(prefix, msg, meta ?? {});
      else if (level === "warn") console.warn(prefix, msg, meta ?? {});
      else console.log(prefix, msg, meta ?? {});
    },
  });
}
