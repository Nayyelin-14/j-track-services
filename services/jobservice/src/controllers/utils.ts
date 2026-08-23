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

const JOBS_LIST_VERSION_KEY = "jobs:list:version";
const COMPANIES_LIST_VERSION_KEY = "companies:list:version";

export const invalidateByPattern = async (pattern: string) => {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      for (const key of keys) {
        await redisClient.del(key);
      }
    }
  } catch (err) {
    console.error("[Redis] Cache invalidation error (non-fatal):", err);
  }
};

export const invalidateJobsCache = async (job_id?: number) => {
  try {
    await redisClient.incr(JOBS_LIST_VERSION_KEY);
  } catch (err) {
    console.error("[Redis] Cache version increment error (non-fatal):", err);
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
    await redisClient.incr(COMPANIES_LIST_VERSION_KEY);
  } catch (err) {
    console.error("[Redis] Cache version increment error (non-fatal):", err);
  }

  if (company_id) {
    try {
      await redisClient.del(CACHE_KEYS.company(company_id));
      await redisClient.del(CACHE_KEYS.companyDetail(company_id));
    } catch (err) {
      console.error("[Redis] Cache invalidation error (non-fatal):", err);
    }
  }
};

async function getListVersion(versionKey: string): Promise<string> {
  try {
    return (await redisClient.get(versionKey)) ?? "0";
  } catch {
    return "0";
  }
}

export { JOBS_LIST_VERSION_KEY, COMPANIES_LIST_VERSION_KEY, getListVersion };

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

export const sanitizePositiveInt = (val: unknown, field: string): number => {
  const num = parseInt(val as string);
  if (isNaN(num) || num <= 0) {
    throw new ErrorHandler(400, `${field} must be a positive number`);
  }
  return num;
};

const MAX_SALARY_VALUE = 99999999.99;
const MAX_SALARY_LENGTH = 64;

// Validates a single salary amount (number or numeric string) and returns its
// canonical string form.
const parseSalaryAmount = (raw: string, field: string): string => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ErrorHandler(400, `${field} must be a positive number`);
  }
  if (parsed > MAX_SALARY_VALUE) {
    throw new ErrorHandler(400, `${field} value is too large`);
  }
  // Reject strings with stray characters that Number() tolerates
  // (e.g. "0x10", "1e5", "Infinity") — only plain decimals are allowed.
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new ErrorHandler(
      400,
      `${field} must be a positive number with at most 2 decimal places`,
    );
  }
  return raw;
};

// Accepts either a single salary ("150000", 150000) or an explicit range
// ("1000-2000"). Range values round-trip exactly as provided; single amounts
// are normalized to their canonical decimal string.
export const parseSalary = (
  val: unknown,
  field = "Salary",
): string | null | undefined => {
  if (val === undefined) return undefined;
  if (val === null || val === "") return null;
  if (typeof val === "number") {
    val = String(val);
  }
  if (typeof val !== "string") {
    throw new ErrorHandler(400, `${field} must be a number or a range like "1000-2000"`);
  }
  const trimmed = val.trim();
  if (trimmed.length > MAX_SALARY_LENGTH) {
    throw new ErrorHandler(400, `${field} must be at most ${MAX_SALARY_LENGTH} characters`);
  }
  if (trimmed.includes("-")) {
    const [minRaw, maxRaw] = trimmed.split("-");
    if (minRaw === undefined || maxRaw === undefined || trimmed.split("-").length !== 2) {
      throw new ErrorHandler(
        400,
        `${field} range must look like "1000-2000"`,
      );
    }
    const min = parseSalaryAmount(minRaw.trim(), `${field} minimum`);
    const max = parseSalaryAmount(maxRaw.trim(), `${field} maximum`);
    if (Number(min) > Number(max)) {
      throw new ErrorHandler(400, `${field} range minimum cannot exceed maximum`);
    }
    return `${min}-${max}`;
  }
  return parseSalaryAmount(trimmed, field);
};

export const JOB_TYPES = ["Full-time", "Part-time", "Contract", "Internship"] as const;
export const WORK_LOCATIONS = ["On-site", "Remote", "Hybrid"] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type WorkLocation = (typeof WORK_LOCATIONS)[number];

const JOB_TYPE_MAP: Record<string, string> = {
  "Full-time": "Full_time",
  "Part-time": "Part_time",
  Contract: "Contract",
  Internship: "Internship",
};

const WORK_LOCATION_MAP: Record<string, string> = {
  "On-site": "On_site",
  Remote: "Remote",
  Hybrid: "Hybrid",
};

export function mapJobType(v: string): string {
  return JOB_TYPE_MAP[v] ?? v;
}

export function mapWorkLocation(v: string): string {
  return WORK_LOCATION_MAP[v] ?? v;
}
