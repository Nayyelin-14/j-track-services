import "dotenv/config";
import app, { errorMiddleware } from "./app.js";
import routes from "./routes/upload.js";
import aiRoutes from "./routes/ai.js";
import analyzeRoute from "./routes/resume.js";
import { v2 as cloudinary } from "cloudinary";
import { createMailConsumer } from "./consumer.js";
import { createNotificationConsumer } from "./notification-consumer.js";
import { ensureTopic } from "@jtrack/shared/kafka/topic";

function initCloudinary() {
  const CLOUD_NAME = process.env["CLOUD_NAME"];
  const CLOUD_API_KEY = process.env["CLOUD_API_KEY"];
  const CLOUD_API_SECRET = process.env["CLOUD_API_SECRET"];
  if (!CLOUD_NAME || !CLOUD_API_KEY || !CLOUD_API_SECRET) {
    console.warn("[Cloudinary] Missing credentials — upload routes will fail");
    return;
  }
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: CLOUD_API_KEY,
    api_secret: CLOUD_API_SECRET,
  });
}

const mailConsumer = createMailConsumer();
export { mailConsumer };
const notificationConsumer = createNotificationConsumer();
export { notificationConsumer };

app.use("/api/utils", routes);
app.use("/api/utils/ai/", aiRoutes);
app.use("/api/utils/ai", analyzeRoute);

app.use(errorMiddleware);

app.get("/health", async (_req, res) => {
  const [mailHealth, notifHealth] = await Promise.all([
    mailConsumer.healthCheck(),
    notificationConsumer.healthCheck(),
  ]);
  const allConnected = mailHealth.connected && notifHealth.connected;

  res.status(allConnected ? 200 : 503).json({
    service: "utils-service",
    status: allConnected ? "healthy" : "degraded",
    consumers: {
      mail: mailHealth,
      notification: notifHealth,
    },
  });
});

async function gracefulShutdown() {
  console.log("\n[SIGTERM] Shutting down gracefully...");
  await Promise.all([
    mailConsumer.stop().catch((err) => console.error("[Mail Consumer] Stop error:", err)),
    notificationConsumer.stop().catch((err) => console.error("[Notification Consumer] Stop error:", err)),
  ]);
  console.log("[Shutdown] Complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function startServer() {
  const PORT = Number(process.env.PORT) || 6001;

  try {
    initCloudinary();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Utils Service] Running on port ${PORT}`);
    });

    await ensureTopic("send-mail");
    await ensureTopic("send-mail-dlq");
    await ensureTopic("job-events");
    await mailConsumer.start();
    console.log("[Mail Consumer] Started");

    await notificationConsumer.start();
    console.log("[Notification Consumer] Started");
  } catch (err) {
    console.error("[Utils Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
