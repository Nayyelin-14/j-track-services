import { createClient } from "redis";

export const redisClient = createClient({
  url: process.env.REDIS_URL!,
  // Reject commands immediately while disconnected instead of queueing
  // them forever — lets callers fall back gracefully during Redis outages.
  disableOfflineQueue: true,
  ...(process.env.REDIS_TLS_ENABLED === "true" && {
    socket: {
      tls: true,
      rejectUnauthorized: process.env.REDIS_REJECT_UNAUTHORIZED !== "false",
    },
  }),
});

// Without an "error" listener, any transient socket error (e.g. ETIMEDOUT to
// a remote Redis like Upstash) crashes the whole Node process. Log instead —
// node-redis re-connects automatically.
redisClient.on("error", (err) => {
  console.error("[Redis] Client error:", err.message);
});
