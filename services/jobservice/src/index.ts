import "dotenv/config";
import app from "./app.js";
import { sql } from "@jtrack/shared/db";
import { redisClient } from "./redis.js";
import { kafka } from "./kafka.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";
import type { KafkaHealth } from "@jtrack/shared/kafka/types";
import { createAnalyticsConsumer } from "./analytics/consumer.js";

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

async function initDB() {
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_type') THEN
        CREATE TYPE job_type AS ENUM ('Full-time', 'Part-time', 'Contract', 'Internship');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_location') THEN
        CREATE TYPE work_location AS ENUM ('On-site', 'Remote', 'Hybrid');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_status') THEN
        CREATE TYPE application_status AS ENUM ('Applied', 'Submitted', 'Rejected', 'Hired');
      END IF;
    END $$;
  `;

  await sql`ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'Applied'`;

  await sql`
    CREATE TABLE IF NOT EXISTS companies (
      company_id     SERIAL PRIMARY KEY,
      name           VARCHAR(255) NOT NULL UNIQUE,
      description    TEXT NOT NULL,
      website        VARCHAR(255) NOT NULL,
      location       VARCHAR(255),
      logo           VARCHAR(255),
      logo_public_id VARCHAR(255),
      recruiter_id   INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id                 SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT NOT NULL,
      salary                 NUMERIC(10,2),
      location               VARCHAR(255),
      job_type               job_type NOT NULL,
      openings               NUMERIC(3,1) NOT NULL,
      role                   VARCHAR(255) NOT NULL,
      work_location          work_location NOT NULL,
      company_id             INTEGER NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
      posted_by_recruiter_id INTEGER NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active              BOOLEAN DEFAULT true
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS applications (
      application_id  SERIAL PRIMARY KEY,
      job_id          INTEGER NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      applicant_id    INTEGER NOT NULL,
      applicant_email VARCHAR(255) NOT NULL,
      status          application_status NOT NULL DEFAULT 'Applied',
      resume          VARCHAR(255),
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      subscribed      BOOLEAN,
      UNIQUE (job_id, applicant_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS job_analytics (
      job_id          INTEGER NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      date            DATE NOT NULL DEFAULT CURRENT_DATE,
      views           INTEGER NOT NULL DEFAULT 0,
      applications    INTEGER NOT NULL DEFAULT 0,
      status_changes  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, date)
    )
  `;

  console.log("[DB] Initialized");
}

app.get("/health", async (_req, res) => {
  const kafkaHealth: KafkaHealth = await kafka.healthCheck();
  const dbOk = await sql`SELECT 1`.catch(() => null);
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
  const PORT = process.env.PORT || 7002;

  try {
    await connectRedis();
    await initDB();
    await ensureTopic("send-mail");
    await ensureTopic("job-events");
    await kafka.connect();
    console.log("[Kafka] Producer connected (job-service)");

    analyticsConsumer = createAnalyticsConsumer();
    await analyticsConsumer.start();

    app.listen(PORT, () => {
      console.log(`[Job Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Job Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
