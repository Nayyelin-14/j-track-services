import "dotenv/config";
import app, { errorMiddleware } from "./app.js";
import routes from "./routes/upload.js";
import aiRoutes from "./routes/ai.js";
import analyzeRoute from "./routes/resume.js";
import { v2 as cloudinary } from "cloudinary";
import { createMailConsumer } from "./consumer.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const CLOUD_NAME = getEnv("CLOUD_NAME");
const CLOUD_API_KEY = getEnv("CLOUD_API_KEY");
const CLOUD_API_SECRET = getEnv("CLOUD_API_SECRET");

cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: CLOUD_API_KEY,
  api_secret: CLOUD_API_SECRET,
});

const mailConsumer = createMailConsumer();
export { mailConsumer };

app.use("/api/utils", routes);
app.use("/api/utils/ai/", aiRoutes);
app.use("/api/utils/ai", analyzeRoute);

app.use(errorMiddleware);

app.get("/health", async (_req, res) => {
  const kafkaHealth = await mailConsumer.healthCheck();
  const status = kafkaHealth.connected ? "healthy" : "degraded";

  res.status(status === "healthy" ? 200 : 503).json({
    service: "utils-service",
    status,
    kafka: kafkaHealth,
  });
});

async function gracefulShutdown() {
  console.log("\n[SIGTERM] Shutting down gracefully...");
  await mailConsumer.stop().catch((err) => console.error("[Consumer] Stop error:", err));
  console.log("[Shutdown] Complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function startServer() {
  const PORT = process.env.PORT || 6001;

  try {
    await ensureTopic("send-mail");
    await ensureTopic("send-mail-dlq");
    await mailConsumer.start();
    console.log("[Mail Consumer] Started");

    app.listen(PORT, () => {
      console.log(`[Utils Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Utils Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
