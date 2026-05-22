import { ErrorHandler } from "../errorHandler";

export const createRedisHelpers = (redisClient: any) => {
  const setRedisValue = async (
    key: string,
    value: string,
    ttlSeconds: number = 900,
  ) => {
    try {
      const result = await redisClient.set(key, value, { EX: ttlSeconds });
      if (result !== "OK") throw new Error("Redis SET failed");
      return { success: true, message: "Stored in Redis successfully" };
    } catch (error) {
      console.error("Redis SET error:", error);
      throw new ErrorHandler(500, "Redis operation failed");
    }
  };

  const getRedisValue = async (key: string) => {
    try {
      return await redisClient.get(key);
    } catch (error) {
      console.error("Redis GET error:", error);
      throw new ErrorHandler(500, "Redis read failed");
    }
  };

  const deleteRedisValue = async (key: string) => {
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error("Redis DEL error:", error);
      throw new ErrorHandler(500, "Redis delete failed");
    }
  };

  const incrementRedisValue = async (key: string): Promise<number> => {
    try {
      return await redisClient.incr(key);
    } catch (error) {
      console.error("Redis INCR error:", error);
      throw new ErrorHandler(500, "Redis increment failed");
    }
  };

  // ── Rate limiting helpers ─────────────────────────────────────────────

  const FORGOT_PW_RATE_PREFIX = "forgot_pw_rate:";
  const RESET_ATTEMPT_PREFIX = "reset_attempt:";

  const MAX_FORGOT_REQUESTS = 3;
  const FORGOT_WINDOW_SECS = 900;
  const MAX_RESET_ATTEMPTS = 5;
  const RESET_ATTEMPT_WINDOW = 900;

  const checkForgotPasswordRate = async (email: string): Promise<void> => {
    const key = `${FORGOT_PW_RATE_PREFIX}${email}`;
    const current = await getRedisValue(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= MAX_FORGOT_REQUESTS) {
      throw new ErrorHandler(
        429,
        "Too many reset requests. Please wait 15 minutes.",
      );
    }

    if (count === 0) {
      await setRedisValue(key, "1", FORGOT_WINDOW_SECS);
    } else {
      await incrementRedisValue(key);
    }
  };

  const trackFailedResetAttempt = async (
    userId: number,
    email: string,
    resetTokenPrefix: string,
  ): Promise<void> => {
    const key = `${RESET_ATTEMPT_PREFIX}${userId}${email}`;
    const current = await getRedisValue(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= MAX_RESET_ATTEMPTS) {
      await deleteRedisValue(`${resetTokenPrefix}${userId}${email}`);
      throw new ErrorHandler(
        429,
        "Too many failed attempts. Request a new reset link.",
      );
    }

    if (count === 0) {
      await setRedisValue(key, "1", RESET_ATTEMPT_WINDOW);
    } else {
      await incrementRedisValue(key);
    }
  };

  const clearFailedResetAttempts = async (
    userId: number,
    email: string,
  ): Promise<void> => {
    await deleteRedisValue(`${RESET_ATTEMPT_PREFIX}${userId}${email}`);
  };

  const clearForgotPasswordRate = async (email: string): Promise<void> => {
    await deleteRedisValue(`${FORGOT_PW_RATE_PREFIX}${email}`);
  };

  return {
    setRedisValue,
    getRedisValue,
    deleteRedisValue,
    incrementRedisValue,
    checkForgotPasswordRate,
    trackFailedResetAttempt,
    clearFailedResetAttempts,
    clearForgotPasswordRate,
  };
};
