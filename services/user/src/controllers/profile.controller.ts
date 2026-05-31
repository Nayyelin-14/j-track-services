import { Request, Response } from "express";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { withCache } from "@jtrack/shared/redis/helpers";
import { redisClient } from "../redis.js";
import { CACHE_KEYS, invalidateUserCache } from "./utils.js";

export const getMe = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { data: user, fromCache } = await withCache(
    redisClient,
    CACHE_KEYS.userMe(userData.user_id),
    300,
    async () => {
      const [user] = await sql`
        SELECT
          u.user_id,
          u.name,
          u.email,
          u.role,
          u.phone_number,
          u.bio,
          u.resume,
          u.profile_pic,
          u.created_at,
          u.subscription,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT('skill_id', s.skill_id, 'name', s.name)
            ) FILTER (WHERE s.skill_id IS NOT NULL),
            '[]'
          ) AS skills
        FROM users u
        LEFT JOIN user_skills us ON u.user_id = us.user_id
        LEFT JOIN skills s ON us.skill_id = s.skill_id
        WHERE u.user_id = ${userData.user_id}
        GROUP BY u.user_id
        LIMIT 1
      `;

      if (!user) {
        throw new ErrorHandler(404, "User not found");
      }

      return user;
    },
  );

  return res.json({ success: true, user, ...(fromCache && { fromCache }) });
});

export const getUserById = TryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = parseInt(id as string, 10);

  if (isNaN(userId) || userId <= 0) {
    throw new ErrorHandler(400, "Invalid user ID");
  }

  const cacheKey = `user:${userId}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return res.json({ success: true, user: parsed, fromCache: true });
      } catch {
        console.warn("[Redis] Cache parse error, skipping cache");
      }
    }
  } catch (err) {
    console.error("[Redis] Cache read error (non-fatal):", err);
  }

  const [user] = await sql`
    SELECT
      u.user_id,
      u.name,
      u.role,
      u.bio,
      u.profile_pic,
      u.created_at,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT('skill_id', s.skill_id, 'name', s.name)
        ) FILTER (WHERE s.skill_id IS NOT NULL),
        '[]'
      ) AS skills
    FROM users u
    LEFT JOIN user_skills us ON u.user_id = us.user_id
    LEFT JOIN skills s ON us.skill_id = s.skill_id
    WHERE u.user_id = ${userId}
    GROUP BY u.user_id
    LIMIT 1
  `;

  if (!user) {
    throw new ErrorHandler(404, "User not found");
  }

  try {
    await redisClient.setEx(cacheKey, 300, JSON.stringify(user));
  } catch (err) {
    console.error("[Redis] Cache write error (non-fatal):", err);
  }

  return res.json({ success: true, user });
});

export const updateUser = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { name, phone_number, bio } = req.body;

 if (name === undefined && phone_number === undefined && bio === undefined) {
   throw new ErrorHandler(400, "Nothing to update");
 }

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 2) {
      throw new ErrorHandler(400, "Name must be at least 2 characters");
    }
    if (name.trim().length > 255) {
      throw new ErrorHandler(400, "Name is too long");
    }
  }

  if (phone_number !== undefined) {
    const phoneRegex = /^\+?[0-9\s\-().]{7,20}$/;
    if (!phoneRegex.test(phone_number)) {
      throw new ErrorHandler(400, "Invalid phone number format");
    }
  }

  const [existing] = await sql`
    SELECT user_id FROM users WHERE user_id = ${userData.user_id} LIMIT 1
  `;
  if (!existing) throw new ErrorHandler(404, "User not found");

  const [updated] = await sql`
    UPDATE users
    SET
      name         = COALESCE(${name?.trim() ?? null}, name),
      phone_number = COALESCE(${phone_number ?? null}, phone_number),
      bio          = COALESCE(${bio ?? null}, bio)
    WHERE user_id = ${userData.user_id}
    RETURNING user_id, name, email, role, phone_number, bio, profile_pic, created_at
  `;

  await invalidateUserCache(userData.user_id);

  return res.json({ success: true, message: "Profile updated", user: updated });
});

export const updateBio = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { bio } = req.body;

  if (bio === undefined || bio === null) {
    throw new ErrorHandler(400, "Bio is required");
  }

  if (typeof bio !== "string") {
    throw new ErrorHandler(400, "Bio must be a string");
  }

  if (bio.length > 2000) {
    throw new ErrorHandler(400, "Bio must be under 2000 characters");
  }

  const [existing] = await sql`
    SELECT user_id FROM users WHERE user_id = ${userData.user_id} LIMIT 1
  `;
  if (!existing) throw new ErrorHandler(404, "User not found");

  const [updated] = await sql`
    UPDATE users
    SET bio = ${bio.trim()}
    WHERE user_id = ${userData.user_id}
    RETURNING user_id, bio
  `;

  await invalidateUserCache(userData.user_id);

  return res.json({ success: true, message: "Bio updated", user: updated });
});
