import { Request, Response } from "express";
import { prisma } from "@jtrack/shared/db";
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
      const user = await prisma.user.findFirst({
        where: { user_id: userData.user_id },
        select: {
          user_id: true,
          name: true,
          email: true,
          role: true,
          phone_number: true,
          bio: true,
          resume: true,
          profile_pic: true,
          created_at: true,
          subscription: true,
          user_skills: {
            select: {
              skill: {
                select: {
                  skill_id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      if (!user) {
        throw new ErrorHandler(404, "User not found");
      }

      return {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone_number: user.phone_number,
        bio: user.bio,
        resume: user.resume,
        profile_pic: user.profile_pic,
        created_at: user.created_at,
        subscription: user.subscription,
        skills: user.user_skills.map((us) => us.skill),
      };
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

  const user = await prisma.user.findFirst({
    where: { user_id: userId },
    select: {
      user_id: true,
      name: true,
      role: true,
      bio: true,
      profile_pic: true,
      created_at: true,
      user_skills: {
        select: {
          skill: {
            select: {
              skill_id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new ErrorHandler(404, "User not found");
  }

  const result = {
    user_id: user.user_id,
    name: user.name,
    role: user.role,
    bio: user.bio,
    profile_pic: user.profile_pic,
    created_at: user.created_at,
    skills: user.user_skills.map((us) => us.skill),
  };

  try {
    await redisClient.setEx(cacheKey, 300, JSON.stringify(result));
  } catch (err) {
    console.error("[Redis] Cache write error (non-fatal):", err);
  }

  return res.json({ success: true, user: result });
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

  const existing = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: { user_id: true },
  });
  if (!existing) throw new ErrorHandler(404, "User not found");

  const updated = await prisma.user.update({
    where: { user_id: userData.user_id },
    data: {
      ...(name?.trim() && { name: name.trim() }),
      ...(phone_number !== undefined && { phone_number }),
      ...(bio !== undefined && { bio }),
    },
    select: {
      user_id: true,
      name: true,
      email: true,
      role: true,
      phone_number: true,
      bio: true,
      profile_pic: true,
      created_at: true,
    },
  });

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

  if (bio.trim().length === 0) {
    throw new ErrorHandler(400, "Bio cannot be empty");
  }

  if (bio.length > 2000) {
    throw new ErrorHandler(400, "Bio must be under 2000 characters");
  }

  const existing = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: { user_id: true },
  });
  if (!existing) throw new ErrorHandler(404, "User not found");

  const updated = await prisma.user.update({
    where: { user_id: userData.user_id },
    data: { bio: bio.trim() },
    select: { user_id: true, bio: true },
  });

  await invalidateUserCache(userData.user_id);

  return res.json({ success: true, message: "Bio updated", user: updated });
});
