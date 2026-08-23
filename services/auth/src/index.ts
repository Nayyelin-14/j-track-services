import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

import app from "./app.js";
import { prisma } from "@jtrack/shared/db";
import { redisClient } from "./redis.js";
import { kafka } from "./kafka.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";
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
      if (i === maxRetries - 1) {
        console.error("[Redis] All connection attempts exhausted");
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    service: "auth-service",
    status: "ok",
    uptime: process.uptime(),
  });
});

app.get("/health/ready", async (_req, res) => {
  const health = await kafka.healthCheck();
  const dbOk = await prisma.$queryRaw`SELECT 1`.catch(() => null);
  const redisOk = redisClient.isOpen;

  const ready = health.connected && dbOk && redisOk;

  res.status(ready ? 200 : 503).json({
    service: "auth-service",
    status: ready ? "ready" : "not_ready",
    kafka: health,
    database: dbOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
  });
});

async function gracefulShutdown() {
  console.log("\n[SIGTERM] Shutting down gracefully...");
  await Promise.all([
    kafka.disconnect().catch((err: unknown) => console.error("[Kafka] Disconnect error:", err)),
    redisClient.quit().catch((err: unknown) => console.error("[Redis] Quit error:", err)),
  ]);
  console.log("[Shutdown] Complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function startServer() {
  const PORT = Number(process.env.PORT) || 7000;

  try {
    await connectRedis();
    await initDB();
    await ensureTopic("send-mail");
    await kafka.connect();
    console.log("[Kafka] Producer connected (auth-service)");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Auth Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Auth Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
