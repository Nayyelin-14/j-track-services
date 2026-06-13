import { Request, Response, NextFunction } from "express";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { kafka } from "../kafka.js";
import { redisClient } from "../redis.js";
import {
  CACHE_KEYS,
  invalidateJobsCache,
  invalidateCompaniesCache,
  sanitize,
  sanitizePositiveInt,
  JOB_TYPES,
  WORK_LOCATIONS,
  JobType,
  WorkLocation,
  JOBS_LIST_VERSION_KEY,
  getListVersion,
} from "./utils.js";

export const createJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(new ErrorHandler(403, "Only recruiters can create a job"));
    }

    const title = sanitize(req.body.title, "Title", 255);
    const description = sanitize(
      req.body.description,
      "Description",
      5000,
    );
    const role = sanitize(req.body.role, "Role", 255);
    const location = sanitize(req.body.location, "Location", 255);

    const job_type = req.body.job_type as JobType;
    if (!JOB_TYPES.includes(job_type)) {
      return next(
        new ErrorHandler(
          400,
          `job_type must be one of: ${JOB_TYPES.join(", ")}`,
        ),
      );
    }

    const work_location = req.body.work_location as WorkLocation;
    if (!WORK_LOCATIONS.includes(work_location)) {
      return next(
        new ErrorHandler(
          400,
          `work_location must be one of: ${WORK_LOCATIONS.join(", ")}`,
        ),
      );
    }

    const openings = sanitizePositiveInt(req.body.openings, "Openings");
    if (openings > 999) {
      return next(new ErrorHandler(400, "Openings cannot exceed 999"));
    }

    let salary: number | null = null;
    if (req.body.salary !== undefined && req.body.salary !== "") {
      const parsed = parseFloat(req.body.salary);
      if (isNaN(parsed) || parsed < 0) {
        return next(new ErrorHandler(400, "Salary must be a positive number"));
      }
      if (parsed > 99999999.99) {
        return next(new ErrorHandler(400, "Salary value is too large"));
      }
      salary = parsed;
    }

    const company_id = sanitizePositiveInt(req.body.company_id, "Company ID");

    const [company] = await sql`
      SELECT company_id, recruiter_id
      FROM companies
      WHERE company_id  = ${company_id}
      LIMIT 1
    `;
    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }
    if (company.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You do not own this company"));
    }

    const [job] = await sql`
      INSERT INTO jobs (
        title,
        description,
        salary,
        location,
        job_type,
        openings,
        role,
        work_location,
        company_id,
        posted_by_recruiter_id
      ) VALUES (
        ${title},
        ${description},
        ${salary},
        ${location},
        ${job_type},
        ${openings},
        ${role},
        ${work_location},
        ${company_id},
        ${req.user.user_id}
      )
      RETURNING
        job_id,
        title,
        description,
        salary,
        location,
        job_type,
        openings,
        role,
        work_location,
        company_id,
        is_active,
        created_at
    `;
    await invalidateJobsCache();
    await invalidateCompaniesCache(company_id);

    return res.status(201).json({
      success: true,
      message: "Job created successfully",
      job,
    });
  },
);

export const deleteJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(new ErrorHandler(403, "Only recruiters can delete jobs"));
    }

    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const [job] = await sql`
      SELECT
        j.job_id,
        j.company_id,
        c.recruiter_id
      FROM jobs j
      INNER JOIN companies c
        ON j.company_id = c.company_id
      WHERE j.job_id = ${job_id}
      LIMIT 1
    `;

    if (!job) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (job.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You are not authorized to delete this job"));
    }

    await sql`
      DELETE FROM jobs
      WHERE job_id = ${job_id}
    `;
    await invalidateJobsCache(job_id);
    await invalidateCompaniesCache(job.company_id);
    return res.status(200).json({
      success: true,
      message: "Job deleted successfully",
    });
  },
);

export const updateJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(new ErrorHandler(403, "Only recruiters can update jobs"));
    }

    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const [existingJob] = await sql`
      SELECT
        j.*,
        c.recruiter_id
      FROM jobs j
      INNER JOIN companies c
        ON j.company_id = c.company_id
      WHERE j.job_id = ${job_id}
      LIMIT 1
    `;

    if (!existingJob) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (existingJob.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You can only update jobs from your own company"),
      );
    }

    let title = existingJob.title;
    let description = existingJob.description;
    let salary = existingJob.salary;
    let location = existingJob.location;
    let job_type = existingJob.job_type;
    let openings = existingJob.openings;
    let role = existingJob.role;
    let work_location = existingJob.work_location;
    let is_active = existingJob.is_active;

    if (req.body.title !== undefined) {
      title = sanitize(req.body.title, "Title", 255);
    }

    if (req.body.description !== undefined) {
      description = sanitize(req.body.description, "Description", 5000);
    }

    if (req.body.location !== undefined) {
      location = sanitize(req.body.location, "Location", 255);
    }

    if (req.body.role !== undefined) {
      role = sanitize(req.body.role, "Role", 255);
    }

    if (req.body.job_type !== undefined) {
      if (!JOB_TYPES.includes(req.body.job_type)) {
        return next(
          new ErrorHandler(
            400,
            `job_type must be one of: ${JOB_TYPES.join(", ")}`,
          ),
        );
      }
      job_type = req.body.job_type;
    }

    if (req.body.work_location !== undefined) {
      if (!WORK_LOCATIONS.includes(req.body.work_location)) {
        return next(
          new ErrorHandler(
            400,
            `work_location must be one of: ${WORK_LOCATIONS.join(", ")}`,
          ),
        );
      }
      work_location = req.body.work_location;
    }

    if (req.body.openings !== undefined) {
      openings = sanitizePositiveInt(req.body.openings, "Openings");
      if (openings > 999) {
        return next(new ErrorHandler(400, "Openings cannot exceed 999"));
      }
    }

    if (req.body.salary !== undefined) {
      if (req.body.salary === "" || req.body.salary === null) {
        salary = null;
      } else {
        const parsed = parseFloat(req.body.salary);
        if (isNaN(parsed) || parsed < 0) {
          return next(
            new ErrorHandler(400, "Salary must be a positive number"),
          );
        }
        if (parsed > 99999999.99) {
          return next(new ErrorHandler(400, "Salary value is too large"));
        }
        salary = parsed;
      }
    }

    if (req.body.is_active !== undefined) {
      if (typeof req.body.is_active !== "boolean") {
        return next(new ErrorHandler(400, "is_active must be true or false"));
      }
      is_active = req.body.is_active;
    }

    const [updatedJob] = await sql`
      UPDATE jobs
      SET
        title = ${title},
        description = ${description},
        salary = ${salary},
        location = ${location},
        job_type = ${job_type},
        openings = ${openings},
        role = ${role},
        work_location = ${work_location},
        is_active = ${is_active}
      WHERE job_id = ${job_id}
      RETURNING
        job_id,
        title,
        description,
        salary,
        location,
        job_type,
        openings,
        role,
        work_location,
        company_id,
        is_active,
        created_at
    `;
    await invalidateJobsCache(job_id);
    await invalidateCompaniesCache(existingJob.company_id);

    return res.status(200).json({
      success: true,
      message: "Job updated successfully",
      job: updatedJob,
    });
  },
);

export const getAllActiveJobs = TryCatch(
  async (req: AuthRequest, res: Response) => {
    const { title, location } = req.query as {
      title?: string;
      location?: string;
    };

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const filters: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 0;

    if (title) {
      paramIdx++;
      filters.push(`j.title ILIKE $${paramIdx}`);
      params.push(`%${title}%`);
    }

    if (location) {
      paramIdx++;
      filters.push(`j.location ILIKE $${paramIdx}`);
      params.push(`%${location}%`);
    }

    const whereClause = filters.length > 0
      ? `WHERE j.is_active = true AND ${filters.join(" AND ")}`
      : `WHERE j.is_active = true`;

    const version = await getListVersion(JOBS_LIST_VERSION_KEY);
    const cacheKey = `jobs:active:v${version};page=${page};limit=${limit};title=${title ?? ""};location=${location ?? ""}`;

    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.status(200).json({
          success: true,
          count: parsed.jobs.length,
          total: parsed.total,
          page,
          totalPages: Math.ceil(parsed.total / limit),
          jobs: parsed.jobs,
          fromCache: true,
        });
      }
    } catch (err) {
      console.warn("[Redis] Cache read error (non-fatal):", err);
    }

    const countQuery = sql.query(
      `SELECT COUNT(*)::int AS total FROM jobs j ${whereClause}`,
      params,
    );
    const dataQuery = sql.query(
      `SELECT
        j.job_id, j.title, j.description, j.salary, j.location,
        j.job_type, j.role, j.work_location, j.openings, j.created_at,
        c.name AS company_name, c.logo AS company_logo, c.company_id
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      ${whereClause}
      ORDER BY j.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const [[countResult], jobs] = await Promise.all([countQuery, dataQuery]);

    const total = countResult?.total ?? 0;

    try {
      await redisClient.setEx(
        cacheKey,
        60,
        JSON.stringify({ jobs, total }),
      );
    } catch (err) {
      console.warn("[Redis] Cache write error (non-fatal):", err);
    }

    return res.status(200).json({
      success: true,
      count: jobs.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      jobs,
    });
  },
);

export const getJobById = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const cacheKey = `job:${job_id}`;
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        try {
          const job = JSON.parse(cached);
          return res.status(200).json({
            success: true,
            fromCache: true,
            job,
          });
        } catch {
          console.warn("[Redis] Cache parse error, skipping cache");
        }
      }
    } catch (err) {
      console.error("[Redis] Cache read error (non-fatal):", err);
    }

    const [job] = await sql`
      SELECT
        j.job_id,
        j.title,
        j.description,
        j.salary,
        j.location,
        j.job_type,
        j.role,
        j.work_location,
        j.openings,
        j.is_active,
        j.created_at,

        c.company_id,
        c.name         AS company_name,
        c.description  AS company_description,
        c.website      AS company_website,
        c.logo         AS company_logo,

        COUNT(a.application_id) AS total_applications

      FROM jobs j
      JOIN companies c
        ON j.company_id = c.company_id
      LEFT JOIN applications a
        ON j.job_id = a.job_id

      WHERE j.job_id = ${job_id}

      GROUP BY
        j.job_id,
        c.company_id
    `;

    if (!job) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    try {
      await redisClient.setEx(cacheKey, 600, JSON.stringify(job));
    } catch (err) {
      console.error("[Redis] Cache write error (non-fatal):", err);
    }

    kafka.publish("job-events", {
      type: "job.viewed",
      job_id: job.job_id,
      viewer_id: (req as AuthRequest).user?.user_id,
      viewed_at: new Date().toISOString(),
    }).catch((err: unknown) =>
      console.error("[Kafka] Failed to publish job.viewed event:", err),
    );

    return res.status(200).json({
      success: true,
      fromCache: false,
      job,
    });
  },
);
