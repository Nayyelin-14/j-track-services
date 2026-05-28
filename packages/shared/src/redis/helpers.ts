import { ErrorHandler } from "../errorHandler";

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: (string | Buffer)[] }): Promise<unknown>;
}

const RATE_LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  end
  return count
`;

const LOG_PREFIX = "[Redis]";

export async function withCache<T>(
  client: RedisClient,
  key: string,
  ttl: number,
  fetch: () => Promise<T>,
): Promise<{ data: T; fromCache: boolean }> {
  try {
    const cached = await client.get(key);
    if (cached) {
      try {
        return { data: JSON.parse(cached) as T, fromCache: true };
      } catch {
        console.warn(`${LOG_PREFIX} Cache parse error for ${key}, skipping cache`);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Cache read error for ${key} (non-fatal):`, err);
  }

  const data = await fetch();

  try {
    await client.setEx(key, ttl, JSON.stringify(data));
  } catch (err) {
    console.error(`${LOG_PREFIX} Cache write error for ${key} (non-fatal):`, err);
  }

  return { data, fromCache: false };
}

export const createRedisHelpers = (redisClient: RedisClient) => {
  const setRedisValue = async (
    key: string,
    value: string,
    ttlSeconds: number = 900,
  ) => {
    try {
      const result = await redisClient.set(key, value, { EX: ttlSeconds });
      if (result !== "OK") {
        console.warn(`${LOG_PREFIX} SET returned unexpected:`, result);
        return { success: false, message: "Redis SET returned unexpected result" };
      }
      return { success: true, message: "Stored in Redis successfully" };
    } catch (error) {
      console.error(`${LOG_PREFIX} SET error (non-fatal):`, error);
      return { success: false, message: "Redis operation failed" };
    }
  };

  const getRedisValue = async (key: string): Promise<string | null> => {
    try {
      return await redisClient.get(key);
    } catch (error) {
      console.error(`${LOG_PREFIX} GET error (non-fatal):`, error);
      return null;
    }
  };

  const deleteRedisValue = async (key: string) => {
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error(`${LOG_PREFIX} DEL error (non-fatal):`, error);
      return false;
    }
  };

  const incrementRedisValue = async (key: string): Promise<number> => {
    try {
      return await redisClient.incr(key);
    } catch (error) {
      console.error(`${LOG_PREFIX} INCR error (non-fatal):`, error);
      return 0;
    }
  };

  const FORGOT_PW_RATE_PREFIX = "forgot_pw_rate:";
  const RESET_ATTEMPT_PREFIX = "reset_attempt:";

  const MAX_FORGOT_REQUESTS = 3;
  const FORGOT_WINDOW_SECS = 900;
  const MAX_RESET_ATTEMPTS = 5;
  const RESET_ATTEMPT_WINDOW = 900;

  const checkForgotPasswordRate = async (email: string): Promise<void> => {
    try {
      const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
        keys: [`${FORGOT_PW_RATE_PREFIX}${email}`],
        arguments: [String(FORGOT_WINDOW_SECS)],
      });

      const count = Number(result);
      if (count > MAX_FORGOT_REQUESTS) {
        throw new ErrorHandler(
          429,
          "Too many reset requests. Please wait 15 minutes.",
        );
      }
    } catch (error) {
      if (error instanceof ErrorHandler) throw error;
      console.error(`${LOG_PREFIX} Rate limit check failed, allowing request:`, error);
    }
  };

  const trackFailedResetAttempt = async (
    userId: number,
    email: string,
    resetTokenPrefix: string,
  ): Promise<void> => {
    try {
      const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
        keys: [`${RESET_ATTEMPT_PREFIX}${userId}${email}`],
        arguments: [String(RESET_ATTEMPT_WINDOW)],
      });

      const count = Number(result);
      if (count > MAX_RESET_ATTEMPTS) {
        await deleteRedisValue(`${resetTokenPrefix}${userId}${email}`);
        throw new ErrorHandler(
          429,
          "Too many failed attempts. Request a new reset link.",
        );
      }
    } catch (error) {
      if (error instanceof ErrorHandler) throw error;
      console.error(`${LOG_PREFIX} Failed attempt tracking error, allowing request:`, error);
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
