import "dotenv/config";
import app from "./app.js";
import { sql } from "@jtrack/shared/db";
import { redisClient } from "./redis.js";
import { kafka } from "./kafka.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";

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

async function initDB() {
  await sql`
    ALTER TABLE users
    DROP COLUMN IF EXISTS reset_token,
    DROP COLUMN IF EXISTS reset_token_expires,
    DROP COLUMN IF EXISTS reset_token_attempts,
    DROP COLUMN IF EXISTS reset_token_locked_until;
  `;

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('jobseeker', 'recruiter');
      END IF;
    END
    $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      role user_role NOT NULL,
      bio TEXT,
      resume VARCHAR(255),
      refresh_token TEXT,
      resume_public_id VARCHAR(255),
      profile_pic VARCHAR(255),
      profile_pic_public_id VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      subscription TIMESTAMPTZ
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS skills (
      skill_id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      skill_id INTEGER REFERENCES skills(skill_id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, skill_id)
    );
  `;

  console.log("[DB] Initialized");
}

app.get("/health", async (_req, res) => {
  const health = await kafka.healthCheck();
  const dbOk = await sql`SELECT 1`.catch(() => null);
  const redisOk = redisClient.isOpen;

  const status = health.connected && dbOk && redisOk ? "healthy" : "degraded";

  res.status(status === "healthy" ? 200 : 503).json({
    service: "auth-service",
    status,
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
  const PORT = process.env.PORT || 7000;

  try {
    await connectRedis();
    await initDB();
    await ensureTopic("send-mail");
    await kafka.connect();
    console.log("[Kafka] Producer connected (auth-service)");

    app.listen(PORT, () => {
      console.log(`[Auth Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Auth Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
