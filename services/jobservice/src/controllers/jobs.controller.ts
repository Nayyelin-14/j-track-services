import { Request, Response, NextFunction } from "express";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { kafka } from "../kafka.js";
import { redisClient } from "../redis.js";
import { getCorrelationId } from "@jtrack/shared/kafka/correlation";
import { jobPartitionKey } from "@jtrack/shared/kafka/partitioning";
import {
  CACHE_KEYS,
  invalidateJobsCache,
  invalidateCompaniesCache,
  parseSalary,
  sanitize,
  sanitizePositiveInt,
  JOB_TYPES,
  WORK_LOCATIONS,
  JobType,
  WorkLocation,
  JOBS_LIST_VERSION_KEY,
  getListVersion,
  mapJobType,
  mapWorkLocation,
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

    let salary: string | null | undefined;
    try {
      salary = parseSalary(req.body.salary);
    } catch (err) {
      return next(err);
    }

    const company_id = sanitizePositiveInt(req.body.company_id, "Company ID");

    const company = await prisma.company.findFirst({
      where: { company_id },
      select: { company_id: true, recruiter_id: true },
    });
    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }
    if (company.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You do not own this company"));
    }

    const details = req.body.details;
    if (details !== undefined && typeof details !== "object") {
      return next(new ErrorHandler(400, "Details must be a JSON object"));
    }

    const job = await prisma.job.create({
      data: {
        title,
        description,
        location,
        job_type: mapJobType(job_type) as any,
        openings,
        role,
        work_location: mapWorkLocation(work_location) as any,
        company_id,
        posted_by_recruiter_id: req.user.user_id,
        ...(salary !== undefined && salary !== null && { salary }),
        ...(details !== undefined && { details }),
      } as any,
      select: {
        job_id: true,
        title: true,
        description: true,
        salary: true,
        location: true,
        job_type: true,
        openings: true,
        role: true,
        work_location: true,
        company_id: true,
        is_active: true,
        created_at: true,
        details: true,
      },
    });
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

    const job = await prisma.job.findFirst({
      where: { job_id },
      select: {
        job_id: true,
        company_id: true,
        company: { select: { recruiter_id: true } },
      },
    });

    if (!job) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (job.company.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You are not authorized to delete this job"));
    }

    await prisma.job.delete({
      where: { job_id },
    });
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

    const existingJob = await prisma.job.findFirst({
      where: { job_id },
      include: { company: { select: { recruiter_id: true } } },
    });

    if (!existingJob) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (existingJob.company.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You can only update jobs from your own company"),
      );
    }

    const data: any = {};

    if (req.body.title !== undefined) {
      data.title = sanitize(req.body.title, "Title", 255);
    }

    if (req.body.description !== undefined) {
      data.description = sanitize(req.body.description, "Description", 5000);
    }

    if (req.body.location !== undefined) {
      data.location = sanitize(req.body.location, "Location", 255);
    }

    if (req.body.role !== undefined) {
      data.role = sanitize(req.body.role, "Role", 255);
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
      data.job_type = mapJobType(req.body.job_type);
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
      data.work_location = mapWorkLocation(req.body.work_location);
    }

    if (req.body.openings !== undefined) {
      const openings = sanitizePositiveInt(req.body.openings, "Openings");
      if (openings > 999) {
        return next(new ErrorHandler(400, "Openings cannot exceed 999"));
      }
      data.openings = openings;
    }

    if (req.body.salary !== undefined) {
      try {
        const salary = parseSalary(req.body.salary);
        // undefined means the value was absent — nothing to update
        if (salary !== undefined) {
          data.salary = salary;
        }
      } catch (err) {
        return next(err);
      }
    }

    if (req.body.is_active !== undefined) {
      if (typeof req.body.is_active !== "boolean") {
        return next(new ErrorHandler(400, "is_active must be true or false"));
      }
      data.is_active = req.body.is_active;
    }

    if (req.body.details !== undefined) {
      if (req.body.details === null) {
        data.details = null;
      } else if (typeof req.body.details === "object") {
        data.details = req.body.details;
      } else {
        return next(new ErrorHandler(400, "Details must be a JSON object"));
      }
    }

    const updatedJob = await prisma.job.update({
      where: { job_id },
      data,
      select: {
        job_id: true,
        title: true,
        description: true,
        salary: true,
        location: true,
        job_type: true,
        openings: true,
        role: true,
        work_location: true,
        company_id: true,
        is_active: true,
        created_at: true,
        details: true,
      },
    });
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
    const { title, location, job_type, work_location } = req.query as {
      title?: string;
      location?: string;
      job_type?: string | string[];
      work_location?: string | string[];
    };

    const parseFilter = (value: string | string[] | undefined): string[] => {
      if (value === undefined) return [];
      const parts = Array.isArray(value) ? value : [value];
      return parts
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean);
    };

    const rawJobTypes = parseFilter(job_type);
    const rawWorkLocations = parseFilter(work_location);

    const invalidJobType = rawJobTypes.find(
      (v) => !JOB_TYPES.includes(v as JobType),
    );
    if (invalidJobType) {
      throw new ErrorHandler(400, `Invalid job_type filter: ${invalidJobType}`);
    }

    const invalidWorkLocation = rawWorkLocations.find(
      (v) => !WORK_LOCATIONS.includes(v as WorkLocation),
    );
    if (invalidWorkLocation) {
      throw new ErrorHandler(
        400,
        `Invalid work_location filter: ${invalidWorkLocation}`,
      );
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const jobTypeFilters = rawJobTypes.map(mapJobType);
    const workLocationFilters = rawWorkLocations.map(mapWorkLocation);

    const version = await getListVersion(JOBS_LIST_VERSION_KEY);
    const cacheKey = `jobs:active:v${version};page=${page};limit=${limit};title=${title ?? ""};location=${location ?? ""};job_type=${jobTypeFilters.join(",")};work_location=${workLocationFilters.join(",")}`;

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

    const titleFilter = title ? `%${title}%` : null;
    const locationFilter = location ? `%${location}%` : null;

    const where: any = { is_active: true };
    if (titleFilter) {
      where.title = { contains: title, mode: "insensitive" };
    }
    if (locationFilter) {
      where.location = { contains: location, mode: "insensitive" };
    }
    if (jobTypeFilters.length > 0) {
      where.job_type = { in: jobTypeFilters };
    }
    if (workLocationFilters.length > 0) {
      where.work_location = { in: workLocationFilters };
    }

    const [jobs, totalResult] = await Promise.all([
      prisma.job.findMany({
        where,
        select: {
          job_id: true,
          title: true,
          description: true,
          salary: true,
          location: true,
          job_type: true,
          role: true,
          work_location: true,
          openings: true,
          created_at: true,
          details: true,
          company: {
            select: {
              company_id: true,
              name: true,
              logo: true,
            },
          },
        },
        orderBy: { created_at: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    const mappedJobs = jobs.map((j) => ({
      job_id: j.job_id,
      title: j.title,
      description: j.description,
      salary: j.salary,
      location: j.location,
      job_type: j.job_type,
      role: j.role,
      work_location: j.work_location,
      openings: j.openings,
      created_at: j.created_at,
      details: j.details,
      company_name: j.company.name,
      company_logo: j.company.logo,
      company_id: j.company.company_id,
    }));

    try {
      await redisClient.setEx(
        cacheKey,
        60,
        JSON.stringify({ jobs: mappedJobs, total: totalResult }),
      );
    } catch (err) {
      console.warn("[Redis] Cache write error (non-fatal):", err);
    }

    return res.status(200).json({
      success: true,
      count: mappedJobs.length,
      total: totalResult,
      page,
      totalPages: Math.ceil(totalResult / limit),
      jobs: mappedJobs,
    });
  },
);

export const getMyJobs = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can view their jobs"),
      );
    }

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const where: any = { company: { recruiter_id: req.user.user_id } };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { location: { contains: search, mode: "insensitive" } },
        { company: { name: { contains: search, mode: "insensitive" } } },
      ];
    }
    if (status === "active") {
      where.is_active = true;
    } else if (status === "paused") {
      where.is_active = false;
    }

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        select: {
          job_id: true,
          title: true,
          description: true,
          salary: true,
          location: true,
          job_type: true,
          role: true,
          work_location: true,
          openings: true,
          is_active: true,
          created_at: true,
          details: true,
          company: {
            select: {
              company_id: true,
              name: true,
              logo: true,
            },
          },
        },
        orderBy: { created_at: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    const jobIds = jobs.map((j) => j.job_id);
    const counts = jobIds.length
      ? await prisma.application.groupBy({
          by: ["job_id"],
          where: { job_id: { in: jobIds } },
          _count: { _all: true },
        })
      : [];

    const countMap = new Map(counts.map((c) => [c.job_id, c._count._all]));

    const mappedJobs = jobs.map((j) => ({
      job_id: j.job_id,
      title: j.title,
      description: j.description,
      salary: j.salary,
      location: j.location,
      job_type: j.job_type,
      role: j.role,
      work_location: j.work_location,
      openings: j.openings,
      is_active: j.is_active,
      created_at: j.created_at,
      details: j.details,
      company_id: j.company.company_id,
      company_name: j.company.name,
      company_logo: j.company.logo,
      total_applications: countMap.get(j.job_id) ?? 0,
    }));

    return res.status(200).json({
      success: true,
      count: mappedJobs.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      jobs: mappedJobs,
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

    const [jobResult, totalApplications] = await Promise.all([
      prisma.job.findFirst({
        where: { job_id },
        select: {
          job_id: true,
          title: true,
          description: true,
          salary: true,
          location: true,
          job_type: true,
          role: true,
          work_location: true,
          openings: true,
          is_active: true,
          created_at: true,
          details: true,
          company: {
            select: {
              company_id: true,
              name: true,
              description: true,
              website: true,
              logo: true,
            },
          },
        },
      }),
      prisma.application.count({ where: { job_id } }),
    ]);

    if (!jobResult) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    const job = {
      ...jobResult,
      company_id: jobResult.company.company_id,
      company_name: jobResult.company.name,
      company_description: jobResult.company.description,
      company_website: jobResult.company.website,
      company_logo: jobResult.company.logo,
      total_applications: totalApplications,
    };

    try {
      await redisClient.setEx(cacheKey, 600, JSON.stringify(job));
    } catch (err) {
      console.error("[Redis] Cache write error (non-fatal):", err);
    }

    // Deliberately best-effort: job.viewed is fire-and-forget analytics telemetry.
    // It intentionally does NOT go through the transactional outbox — a view is
    // (a) low-value, so a dropped event is acceptable, and (b) must not fail the
    // job-detail response. A publish failure is logged, never retried here; the
    // consumer side treats job.viewed as idempotent-per-call and the loss is
    // acceptable per the documented at-least-once trade-off. All other business
    // events (job.applied, application.status_changed) MUST use the outbox.
    kafka.publish("job-events", {
      type: "job.viewed",
      job_id: job.job_id,
      viewer_id: (req as AuthRequest).user?.user_id,
      viewed_at: new Date().toISOString(),
    }, {
      key: jobPartitionKey(job.job_id),
      correlationId: getCorrelationId(),
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
