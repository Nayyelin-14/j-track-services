import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

import app from "./app.js";
import { prisma } from "@jtrack/shared/db";
import { redisClient } from "./redis.js";
import { kafka } from "./kafka.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";
import type { KafkaHealth } from "@jtrack/shared/kafka/types";
import { startOutboxWorker } from "@jtrack/shared/kafka/outbox";
import type { OutboxWorker } from "@jtrack/shared/kafka/outbox";
import { createAnalyticsConsumer } from "./analytics/consumer.js";
import { initDB } from "./init.js";

async function connectRedis() {
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await redisClient.connect();
      console.log("[Redis] Connected");
      return;
    } catch (err) {
      console.error(`[Redis] Connection attempt ${i + 1} failed:`, err);
      if (i === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    service: "job-service",
    status: "ok",
    uptime: process.uptime(),
  });
});

app.get("/health/ready", async (_req, res) => {
  const kafkaHealth: KafkaHealth = await kafka.healthCheck();
  const dbOk = await prisma.$queryRaw`SELECT 1`.catch(() => null);
  const redisOk = redisClient.isOpen;
  const consumerHealth = analyticsConsumer
    ? await analyticsConsumer.healthCheck()
    : { connected: false };

  const ready = kafkaHealth.connected && dbOk && redisOk && consumerHealth.connected;

  res.status(ready ? 200 : 503).json({
    service: "job-service",
    status: ready ? "ready" : "not_ready",
    kafka: kafkaHealth,
    consumer: consumerHealth,
    database: dbOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
  });
});

let analyticsConsumer: ReturnType<typeof createAnalyticsConsumer> | null = null;
let outboxWorker: OutboxWorker | null = null;

async function gracefulShutdown() {
  console.log("\n[SIGTERM] Shutting down gracefully...");
  await Promise.all([
    kafka.disconnect().catch((err: unknown) => console.error("[Kafka] Disconnect error:", err)),
    redisClient.quit().catch((err: unknown) => console.error("[Redis] Quit error:", err)),
    analyticsConsumer?.stop().catch((err: unknown) => console.error("[Analytics] Stop error:", err)),
    outboxWorker?.stop().catch((err: unknown) => console.error("[Outbox] Stop error:", err)),
  ]);
  console.log("[Shutdown] Complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function startServer() {
  const PORT = Number(process.env.PORT) || 7002;

  try {
    await connectRedis();
    await initDB();
    await ensureTopic("send-mail");
    await ensureTopic("job-events");
    await kafka.connect();
    console.log("[Kafka] Producer connected (job-service)");

    analyticsConsumer = createAnalyticsConsumer();
    await analyticsConsumer.start();

    outboxWorker = startOutboxWorker({
      prisma,
      kafka,
      workerId: "job-service-outbox",
      log: (level, message) =>
        console[level === "error" ? "error" : "log"](message),
    });
    outboxWorker.start();
    console.log("[Outbox] Worker started (job-service-outbox)");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Job Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Job Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
