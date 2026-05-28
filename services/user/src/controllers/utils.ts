import { redisClient } from "../redis.js";

export const UTIL_SERVICE = process.env.UTILS_SERVICE_URL || "http://localhost:6001/api/utils";

export const CACHE_KEYS = {
  userMe: (id: number) => `user:me:${id}`,
  authUser: (id: number) => `auth:user:${id}`,
  skills: "skills:all",
};

export const invalidateUserCache = async (user_id: number) => {
  try {
    await Promise.all([
      redisClient.del(CACHE_KEYS.userMe(user_id)),
      redisClient.del(CACHE_KEYS.authUser(user_id)),
    ]);
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }
};
