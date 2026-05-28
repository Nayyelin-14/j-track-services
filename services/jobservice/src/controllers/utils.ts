import { Request } from "express";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { redisClient } from "../redis.js";

export interface UserPayload {
  user_id: number;
  name: string;
  email: string;
  password: string;
  phone_number: string;
  role: string;
  bio: string | null;
  resume: string | null;
  refresh_token: string | null;
  resume_public_id: string | null;
  profile_pic: string | null;
  profile_pic_public_id: string | null;
  created_at: Date;
  subscription: Date | null;
}

export interface AuthRequest extends Request {
  user?: UserPayload;
}

export const CACHE_KEYS = {
  companies: "companies:all",
  company: (id: number) => `company:${id}`,
  companyDetail: (id: number) => `company:detail:${id}`,
  applications: (id: number) => `applications:user:${id}`,
  applicationsByJob: (id: number) => `applications:job:${id}`,
};

export const invalidateJobsCache = async (job_id?: number) => {
  try {
    for await (const key of redisClient.scanIterator({ MATCH: "jobs:active:*" })) {
      await redisClient.del(key);
    }
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }

  if (job_id) {
    try {
      await redisClient.del(`job:${job_id}`);
    } catch (err) {
      console.error("[Redis] Cache invalidation error (non-fatal):", err);
    }
  }
};

export const invalidateCompaniesCache = async (company_id?: number) => {
  try {
    await redisClient.del(CACHE_KEYS.companies);
    if (company_id) {
      await redisClient.del(CACHE_KEYS.company(company_id));
      await redisClient.del(CACHE_KEYS.companyDetail(company_id));
    }
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }
};

export const sanitize = (val: unknown, field: string, max: number): string => {
  if (typeof val !== "string" || !val.trim()) {
    throw new ErrorHandler(400, `${field} is required`);
  }
  const trimmed = val.trim();
  if (trimmed.length > max) {
    throw new ErrorHandler(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
};

export const sanitizeString = (val: unknown, field: string, max: number): string => {
  if (typeof val !== "string" || !val.trim()) {
    throw new ErrorHandler(400, `${field} is required`);
  }
  const trimmed = val.trim();
  if (trimmed.length > max) {
    throw new ErrorHandler(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
};

export const sanitizePositiveInt = (val: unknown, field: string): number => {
  const num = parseInt(val as string);
  if (isNaN(num) || num <= 0) {
    throw new ErrorHandler(400, `${field} must be a positive number`);
  }
  return num;
};

export const JOB_TYPES = ["Full-time", "Part-time", "Contract", "Internship"] as const;
export const WORK_LOCATIONS = ["On-site", "Remote", "Hybrid"] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type WorkLocation = (typeof WORK_LOCATIONS)[number];
