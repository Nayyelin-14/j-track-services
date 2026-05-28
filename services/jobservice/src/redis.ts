import { createClient } from "redis";

export const redisClient = createClient({
  url: process.env.REDIS_URL!,
  ...(process.env.REDIS_TLS_ENABLED === "true" && {
    socket: {
      tls: true,
      rejectUnauthorized: process.env.REDIS_REJECT_UNAUTHORIZED !== "false",
    },
  }),
});
