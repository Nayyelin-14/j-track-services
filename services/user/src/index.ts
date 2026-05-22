import "dotenv/config";
import { createClient } from "redis";
import app from "./app";

export const redisClient = createClient({
  url: process.env.REDIS_URL!,
});

redisClient
  .connect()
  .then(() => console.log("Redis connected"))
  .catch((err) => console.error("Redis connection error:", err));

const PORT = process.env.PORT || 7001;

app.listen(PORT, () => console.log(`User service running on port ${PORT}`));
