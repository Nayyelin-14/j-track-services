import "dotenv/config";
import app from "./app.js";
import { prisma } from "@jtrack/shared/db";
import { redisClient } from "./redis.js";
import { kafka } from "./kafka.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";
import type { KafkaHealth } from "@jtrack/shared/kafka/types";
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

app.get("/health", async (_req, res) => {
  const kafkaHealth: KafkaHealth = await kafka.healthCheck();
  const dbOk = await prisma.$queryRaw`SELECT 1`.catch(() => null);
  const redisOk = redisClient.isOpen;

  const status = kafkaHealth.connected && dbOk && redisOk ? "healthy" : "degraded";

  res.status(status === "healthy" ? 200 : 503).json({
    service: "job-service",
    status,
    kafka: kafkaHealth,
    database: dbOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
  });
});

let analyticsConsumer: ReturnType<typeof createAnalyticsConsumer> | null = null;

async function gracefulShutdown() {
  console.log("\n[SIGTERM] Shutting down gracefully...");
  await Promise.all([
    kafka.disconnect().catch((err: unknown) => console.error("[Kafka] Disconnect error:", err)),
    redisClient.quit().catch((err: unknown) => console.error("[Redis] Quit error:", err)),
    analyticsConsumer?.stop().catch((err: unknown) => console.error("[Analytics] Stop error:", err)),
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

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Job Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Job Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
