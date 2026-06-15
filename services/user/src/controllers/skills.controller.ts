import { Request, Response } from "express";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { withCache } from "@jtrack/shared/redis/helpers";
import { redisClient } from "../redis.js";
import { CACHE_KEYS, invalidateUserCache } from "./utils.js";

export const addSkills = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { skills } = req.body;

  if (!Array.isArray(skills) || skills.length === 0) {
    throw new ErrorHandler(400, "Skills array is required");
  }

  if (skills.length > 30) {
    throw new ErrorHandler(400, "Cannot add more than 30 skills at once");
  }

  const sanitized = skills
    .map((s: any) => (typeof s === "string" ? s.trim().toLowerCase() : null))
    .filter((s): s is string => !!s && s.length > 0 && s.length <= 100);

  if (sanitized.length === 0) {
    throw new ErrorHandler(400, "No valid skill names provided");
  }

  const userExists = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: { user_id: true },
  });
  if (!userExists) throw new ErrorHandler(404, "User not found");

  for (const name of sanitized) {
    const skill = await prisma.skill.upsert({
      where: { name },
      create: { name },
      update: {},
    });

    await prisma.userSkill.upsert({
      where: {
        user_id_skill_id: {
          user_id: userData.user_id,
          skill_id: skill.skill_id,
        },
      },
      create: {
        user_id: userData.user_id,
        skill_id: skill.skill_id,
      },
      update: {},
    });
  }

  const userSkills = await prisma.userSkill.findMany({
    where: { user_id: userData.user_id },
    select: {
      skill: {
        select: { skill_id: true, name: true },
      },
    },
    orderBy: { skill: { name: "asc" } },
  });

  await invalidateUserCache(userData.user_id);
  try {
    await redisClient.del(CACHE_KEYS.skills);
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }

  return res.json({
    success: true,
    message: "Skills added",
    skills: userSkills.map((us: { skill: unknown }) => us.skill),
  });
});

export const removeSkills = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { skill_ids } = req.body || {};

  if (!Array.isArray(skill_ids) || skill_ids.length === 0) {
    throw new ErrorHandler(400, "skill_ids array is required");
  }

  const validIds = skill_ids.filter(
    (id: any) => typeof id === "number" && Number.isInteger(id) && id > 0,
  );

  if (validIds.length === 0) {
    throw new ErrorHandler(400, "No valid skill IDs provided");
  }

  await prisma.userSkill.deleteMany({
    where: {
      user_id: userData.user_id,
      skill_id: { in: validIds },
    },
  });

  const remaining = await prisma.userSkill.findMany({
    where: { user_id: userData.user_id },
    select: {
      skill: {
        select: { skill_id: true, name: true },
      },
    },
    orderBy: { skill: { name: "asc" } },
  });

  await invalidateUserCache(userData.user_id);

  return res.json({
    success: true,
    message: "Skills removed",
    skills: remaining.map((us: { skill: unknown }) => us.skill),
  });
});

export const getAllSkills = TryCatch(async (_req: Request, res: Response) => {
  const { data: skills } = await withCache(
    redisClient,
    CACHE_KEYS.skills,
    3600,
    async () => {
      return await prisma.skill.findMany({
        select: { skill_id: true, name: true },
        orderBy: { name: "asc" },
      });
    },
  );

  return res.json({ success: true, skills });
});
