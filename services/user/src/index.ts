import "dotenv/config";
import app from "./app.js";
import { redisClient } from "./redis.js";

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

async function startServer() {
  const PORT = process.env.PORT || 7001;

  try {
    await connectRedis();

    app.listen(PORT, () => {
      console.log(`[User Service] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[User Service] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
