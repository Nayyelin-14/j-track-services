import { Request, Response } from "express";
import { sql } from "@jtrack/shared/db";
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

  const [userExists] = await sql`
    SELECT user_id FROM users WHERE user_id = ${userData.user_id} LIMIT 1
  `;
  if (!userExists) throw new ErrorHandler(404, "User not found");

  const skillIds: number[] = [];
  for (const name of sanitized) {
    const [skill] = await sql`
      INSERT INTO skills (name)
      VALUES (${name})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING skill_id
    `;
    skillIds.push(skill?.skill_id);
  }

  for (const skillId of skillIds) {
    await sql`
      INSERT INTO user_skills (user_id, skill_id)
      VALUES (${userData.user_id}, ${skillId})
      ON CONFLICT DO NOTHING
    `;
  }

  const userSkills = await sql`
    SELECT s.skill_id, s.name
    FROM user_skills us
    JOIN skills s ON us.skill_id = s.skill_id
    WHERE us.user_id = ${userData.user_id}
    ORDER BY s.name
  `;

  await invalidateUserCache(userData.user_id);
  try {
    await redisClient.del(CACHE_KEYS.skills);
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }

  return res.json({
    success: true,
    message: "Skills added",
    skills: userSkills,
  });
});

export const removeSkills = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { skill_ids } = req.body;

  if (!Array.isArray(skill_ids) || skill_ids.length === 0) {
    throw new ErrorHandler(400, "skill_ids array is required");
  }

  const validIds = skill_ids.filter(
    (id: any) => typeof id === "number" && Number.isInteger(id) && id > 0,
  );

  if (validIds.length === 0) {
    throw new ErrorHandler(400, "No valid skill IDs provided");
  }

  await sql`
    DELETE FROM user_skills
    WHERE user_id = ${userData.user_id}
      AND skill_id = ANY(${validIds}::int[])
  `;

  const remaining = await sql`
    SELECT s.skill_id, s.name
    FROM user_skills us
    JOIN skills s ON us.skill_id = s.skill_id
    WHERE us.user_id = ${userData.user_id}
    ORDER BY s.name
  `;

  await invalidateUserCache(userData.user_id);

  return res.json({
    success: true,
    message: "Skills removed",
    skills: remaining,
  });
});

export const getAllSkills = TryCatch(async (_req: Request, res: Response) => {
  const { data: skills } = await withCache(
    redisClient,
    CACHE_KEYS.skills,
    3600,
    async () => {
      return await sql`
        SELECT skill_id, name FROM skills ORDER BY name
      `;
    },
  );

  return res.json({ success: true, skills });
});
