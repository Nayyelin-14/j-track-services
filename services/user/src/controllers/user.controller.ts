import { Request, Response } from "express";
import axios from "axios";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { getBuffer } from "@jtrack/shared/buffer";
import { redisClient } from "../index.js";

const UTIL_SERVICE = process.env.UTILS_SERVICE_URL || "http://localhost:6001";

// ─── GET /me ────────────────────────────────────────────────────────────────
// Returns full user profile including skills
export const getMe = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

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

  return res.json({ success: true, user });
});

// ─── GET /:id ────────────────────────────────────────────────────────────────
// Public profile by user_id
// controllers/user.controller.ts
export const getUserById = TryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = parseInt(id as string, 10);

  if (isNaN(userId) || userId <= 0) {
    throw new ErrorHandler(400, "Invalid user ID");
  }

  // Check cache first
  const cacheKey = `user:${userId}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return res.json({ success: true, user: JSON.parse(cached) });
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

  // Cache for 5 minutes
  await redisClient.setEx(cacheKey, 300, JSON.stringify(user));

  return res.json({ success: true, user });
});

// ─── PUT /update ─────────────────────────────────────────────────────────────
// Update name, phone_number, bio (safe fields only — email/password/role excluded)
export const updateUser = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { name, phone_number, bio } = req.body;

  // At least one field must be provided
 if (name === undefined && phone_number === undefined && bio === undefined) {
   throw new ErrorHandler(400, "Nothing to update");
 }

  // Validate individually only when provided
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

  return res.json({ success: true, message: "Profile updated", user: updated });
});

// ─── PUT /bio ─────────────────────────────────────────────────────────────────
// Dedicated bio update endpoint
export const updateBio = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

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

  return res.json({ success: true, message: "Bio updated", user: updated });
});

// ─── POST /profile-pic ────────────────────────────────────────────────────────
// Upload / replace profile picture via util service
export const uploadProfilePic = TryCatch(
  async (req: Request, res: Response) => {
    const userData = (req as any).user;

    if (!userData?.user_id) {
      throw new ErrorHandler(401, "Unauthorized");
    }

    const file = req.file;
    if (!file) {
      throw new ErrorHandler(400, "Image file is required");
    }

    // Only allow image types
    if (!file.mimetype.startsWith("image/")) {
      throw new ErrorHandler(400, "Only image files are allowed");
    }

    const fileBuffer = getBuffer(file);
    if (!fileBuffer?.content) {
      throw new ErrorHandler(500, "Failed to process image");
    }

    // Fetch current public_id to delete old image on Cloudinary
    const [currentUser] = await sql`
    SELECT profile_pic_public_id FROM users WHERE user_id = ${userData.user_id} LIMIT 1
  `;
    if (!currentUser) throw new ErrorHandler(404, "User not found");

    const uploadPayload: Record<string, string> = {
      buffer: fileBuffer.content,
    };
    if (currentUser.profile_pic_public_id) {
      uploadPayload.public_id = currentUser.profile_pic_public_id;
    }

    let uploadRes;
    try {
      uploadRes = await axios.post(`${UTIL_SERVICE}/upload`, uploadPayload, {
        timeout: 30_000,
      });
    } catch {
      throw new ErrorHandler(502, "Upload service unavailable");
    }

    if (!uploadRes.data?.success) {
      throw new ErrorHandler(500, "Upload failed");
    }

    const { url, public_id } = uploadRes.data;
    if (!url || !public_id) {
      throw new ErrorHandler(500, "Invalid response from upload service");
    }

    const [updated] = await sql`
    UPDATE users
    SET profile_pic = ${url}, profile_pic_public_id = ${public_id}
    WHERE user_id = ${userData.user_id}
    RETURNING user_id, profile_pic
  `;

    return res.json({
      success: true,
      message: "Profile picture updated",
      profile_pic: updated?.profile_pic,
    });
  },
);

// ─── POST /resume ─────────────────────────────────────────────────────────────
// Upload / replace resume — jobseekers only
export const uploadResume = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  if (userData.role !== "jobseeker") {
    throw new ErrorHandler(403, "Only job seekers can upload a resume");
  }

  const file = req.file;
  if (!file) {
    throw new ErrorHandler(400, "Resume file is required");
  }

  // Only allow PDF
  const allowedMimes = ["application/pdf"];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ErrorHandler(400, "Only PDF files are allowed for resumes");
  }

  const fileBuffer = getBuffer(file);
  if (!fileBuffer?.content) {
    throw new ErrorHandler(500, "Failed to process resume file");
  }

  const [currentUser] = await sql`
    SELECT resume_public_id FROM users WHERE user_id = ${userData.user_id} LIMIT 1
  `;
  if (!currentUser) throw new ErrorHandler(404, "User not found");

  const uploadPayload: Record<string, string> = {
    buffer: fileBuffer.content,
  };
  if (currentUser.resume_public_id) {
    uploadPayload.public_id = currentUser.resume_public_id;
  }

  let uploadRes;
  try {
    uploadRes = await axios.post(`${UTIL_SERVICE}/upload`, uploadPayload, {
      timeout: 30_000,
    });
  } catch {
    throw new ErrorHandler(502, "Upload service unavailable");
  }

  if (!uploadRes.data?.success) {
    throw new ErrorHandler(500, "Resume upload failed");
  }

  const { url, public_id } = uploadRes.data;
  if (!url || !public_id) {
    throw new ErrorHandler(500, "Invalid response from upload service");
  }

  const [updated] = await sql`
    UPDATE users
    SET resume = ${url}, resume_public_id = ${public_id}
    WHERE user_id = ${userData.user_id}
    RETURNING user_id, resume
  `;

  return res.json({
    success: true,
    message: "Resume updated",
    resume: updated?.resume,
  });
});

// ─── POST /skills ──────────────────────────────────────────────────────────────
// Add skills to user (creates skill if it doesn't exist)
export const addSkills = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { skills } = req.body; // string[]

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

  // Upsert each skill and collect skill_ids
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

  // Link skills to user (ignore duplicates)
  for (const skillId of skillIds) {
    await sql`
      INSERT INTO user_skills (user_id, skill_id)
      VALUES (${userData.user_id}, ${skillId})
      ON CONFLICT DO NOTHING
    `;
  }

  // Return updated skill list
  const userSkills = await sql`
    SELECT s.skill_id, s.name
    FROM user_skills us
    JOIN skills s ON us.skill_id = s.skill_id
    WHERE us.user_id = ${userData.user_id}
    ORDER BY s.name
  `;

  return res.json({
    success: true,
    message: "Skills added",
    skills: userSkills,
  });
});

// ─── DELETE /skills ────────────────────────────────────────────────────────────
// Remove specific skills from user
export const removeSkills = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { skill_ids } = req.body; // number[]

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

  return res.json({
    success: true,
    message: "Skills removed",
    skills: remaining,
  });
});

// ─── GET /skills ───────────────────────────────────────────────────────────────
// Get all available skills (for autocomplete etc.)
export const getAllSkills = TryCatch(async (_req: Request, res: Response) => {
  const skills = await sql`
    SELECT skill_id, name FROM skills ORDER BY name
  `;
  return res.json({ success: true, skills });
});
