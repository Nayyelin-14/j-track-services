import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { getBuffer } from "@jtrack/shared/buffer";
import { kafka } from "../kafka.js";
import { redisClient } from "../redis.js";
import { applicationStatusTemplate } from "../utils/template.js";

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

const invalidateJobsCache = async (job_id?: number) => {
  const keys = await redisClient.keys("jobs:active:*");
  if (keys.length > 0) await redisClient.del(keys);

  if (job_id) {
    await redisClient.del(`job:${job_id}`);
  }
};

const sanitize = (val: unknown, field: string, max: number): string => {
  if (typeof val !== "string" || !val.trim()) {
    throw new ErrorHandler(400, `${field} is required`);
  }
  const trimmed = val.trim();
  if (trimmed.length > max) {
    throw new ErrorHandler(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
};

const sanitizeString = (val: unknown, field: string, max: number): string => {
  if (typeof val !== "string" || !val.trim()) {
    throw new ErrorHandler(400, `${field} is required`);
  }
  const trimmed = val.trim();
  if (trimmed.length > max) {
    throw new ErrorHandler(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
};

const sanitizePositiveInt = (val: unknown, field: string): number => {
  const num = parseInt(val as string);
  if (isNaN(num) || num <= 0) {
    throw new ErrorHandler(400, `${field} must be a positive number`);
  }
  return num;
};

const JOB_TYPES = ["Full-time", "Part-time", "Contract", "Internship"] as const;
const WORK_LOCATIONS = ["On-site", "Remote", "Hybrid"] as const;

type JobType = (typeof JOB_TYPES)[number];
type WorkLocation = (typeof WORK_LOCATIONS)[number];

export const createCompany = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can create a company"),
      );
    }

    if (!req.file) {
      return next(new ErrorHandler(400, "Company logo is required"));
    }

    const name = sanitize(req.body.name, "Name", 255);
    const description = sanitize(req.body.description, "Description", 5000);
    const website = sanitize(req.body.website, "Website", 255);

    try {
      const url = new URL(website);
      if (!["http:", "https:"].includes(url.protocol)) {
        return next(new ErrorHandler(400, "Website must be http or https"));
      }
    } catch {
      return next(new ErrorHandler(400, "Website must be a valid URL"));
    }

    const [existing] = await sql`
      SELECT company_id FROM companies
      WHERE LOWER(name) = LOWER(${name})
      LIMIT 1
    `;
    if (existing) {
      return next(new ErrorHandler(409, "Company name already taken"));
    }

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(req.file.mimetype)) {
      return next(new ErrorHandler(400, "Logo must be JPEG, PNG, or WebP"));
    }
    if (req.file.size > 5 * 1024 * 1024) {
      return next(new ErrorHandler(400, "Logo must be smaller than 5 MB"));
    }

    const dataUri = getBuffer(req.file);
    if (!dataUri?.content) {
      return next(new ErrorHandler(500, "Failed to process logo"));
    }

    const uploadRes = await axios.post(
      `${process.env.UTILS_SERVICE_URL}/upload`,
      { buffer: dataUri.content },
    );

    if (!uploadRes.data.success) {
      return next(new ErrorHandler(500, "Logo upload failed"));
    }

    const { url: logo, public_id: logo_public_id } = uploadRes.data;

    const [company] = await sql`
      INSERT INTO companies
        (name, description, website, logo, logo_public_id, recruiter_id)
      VALUES
        (${name}, ${description}, ${website},
         ${logo}, ${logo_public_id}, ${req.user.user_id})
      RETURNING
        company_id, name, description, website, logo, created_at
    `;

    return res.status(201).json({
      success: true,
      message: "Company created successfully",
      company,
    });
  },
);

export const deleteCompany = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can delete a company"),
      );
    }

    const companyId = parseInt(req.params.id as string);
    if (isNaN(companyId) || companyId <= 0) {
      return next(new ErrorHandler(400, "Invalid company ID"));
    }

    const [company] = await sql`
      SELECT company_id, recruiter_id, logo_public_id
      FROM companies
      WHERE company_id = ${companyId}
      LIMIT 1
    `;
    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }

    if (company.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You are not authorized to delete this company"),
      );
    }

    if (company.logo_public_id) {
      try {
        await axios.delete(
          `${process.env.UTILS_SERVICE_URL}/${encodeURIComponent(company.logo_public_id)}`,
        );
      } catch (err) {
        console.error("Cloudinary delete failed:", err);
        return res.status(404).json({
          success: false,
          message: "Company deleted successfully",
          error: err,
        });
      }
    }

    await sql`
      DELETE FROM companies
      WHERE company_id = ${companyId}
    `;

    return res.status(200).json({
      success: true,
      message: "Company deleted successfully",
    });
  },
);

export const createJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(new ErrorHandler(403, "Only recruiters can create a job"));
    }

    const title = sanitizeString(req.body.title, "Title", 255);
    const description = sanitizeString(
      req.body.description,
      "Description",
      5000,
    );
    const role = sanitizeString(req.body.role, "Role", 255);
    const location = sanitizeString(req.body.location, "Location", 255);

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
      return next(new ErrorHandler(403, "Something went wrong"));
    }

    await sql`
      DELETE FROM jobs
      WHERE job_id = ${job_id}
    `;
    await invalidateJobsCache(job_id);
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
      title = sanitizeString(req.body.title, "Title", 255);
    }

    if (req.body.description !== undefined) {
      description = sanitizeString(req.body.description, "Description", 5000);
    }

    if (req.body.location !== undefined) {
      location = sanitizeString(req.body.location, "Location", 255);
    }

    if (req.body.role !== undefined) {
      role = sanitizeString(req.body.role, "Role", 255);
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

    return res.status(200).json({
      success: true,
      message: "Job updated successfully",
      job: updatedJob,
    });
  },
);

export const getAllCompanies = TryCatch(
  async (_req: Request, res: Response) => {
    const companies = await sql`
      SELECT
        company_id,
        name,
        description,
        website,
        location,
        logo,
        created_at
      FROM companies
      ORDER BY created_at DESC
    `;

    return res.status(200).json({
      success: true,
      count: companies.length,
      companies,
    });
  },
);

export const getCompanyById = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const company_id = sanitizePositiveInt(req.params.company_id, "Company ID");

    const [company] = await sql`
      SELECT
        company_id,
        name,
        description,
        website,
        location,
        logo,
        created_at
      FROM companies
      WHERE company_id = ${company_id}
      LIMIT 1
    `;

    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }

    return res.status(200).json({
      success: true,
      company,
    });
  },
);

export const getCompanyDetail = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can access company details"),
      );
    }

    const company_id = sanitizePositiveInt(req.params.company_id, "Company ID");

    const [company] = await sql`
      SELECT
        c.company_id,
        c.name,
        c.description,
        c.website,
        c.logo,
        c.logo_public_id,
        c.created_at,
        c.recruiter_id,

        u.user_id,
        u.name AS recruiter_name,
        u.email AS recruiter_email,

        COALESCE(
          JSON_AGG(
            CASE
              WHEN j.job_id IS NOT NULL THEN
                JSON_BUILD_OBJECT(
                  'job_id', j.job_id,
                  'title', j.title,
                  'description', j.description,
                  'salary', j.salary,
                  'location', j.location,
                  'job_type', j.job_type,
                  'openings', j.openings,
                  'role', j.role,
                  'work_location', j.work_location,
                  'is_active', j.is_active,
                  'created_at', j.created_at
                )
            END
          ) FILTER (WHERE j.job_id IS NOT NULL),
          '[]'
        ) AS jobs

      FROM companies c

      INNER JOIN users u
        ON c.recruiter_id = u.user_id

      LEFT JOIN jobs j
        ON c.company_id = j.company_id

      WHERE c.company_id = ${company_id}

      GROUP BY
        c.company_id,
        u.user_id

      LIMIT 1
    `;

    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }

    if (company.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You can only access your own company"),
      );
    }

    return res.status(200).json({
      success: true,
      company: {
        company_id: company.company_id,
        name: company.name,
        description: company.description,
        website: company.website,
        logo: company.logo,
        logo_public_id: company.logo_public_id,
        created_at: company.created_at,

        recruiter: {
          user_id: company.user_id,
          name: company.recruiter_name,
          email: company.recruiter_email,
        },

        jobs: company.jobs,
      },
    });
  },
);

export const getAllActiveJobs = TryCatch(
  async (req: AuthRequest, res: Response) => {
    const { title, location } = req.query as {
      title?: string;
      location?: string;
    };

    const cacheKey = `jobs:active:title=${title ?? ""};location=${location ?? ""}`;

    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const jobs = JSON.parse(cached);
      return res.status(200).json({
        success: true,
        count: jobs.length,
        fromCache: true,
        jobs,
      });
    }

    let querySting = `
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
        j.created_at,
        c.name AS company_name,
        c.logo AS company_logo,
        c.company_id AS company_id
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      WHERE j.is_active = true
    `;

    const values: any[] = [];
    let paramIndex = 1;

    if (title) {
      querySting += ` AND j.title ILIKE $${paramIndex}`;
      values.push(`%${title}%`);
      paramIndex++;
    }

    if (location) {
      querySting += ` AND j.location ILIKE $${paramIndex}`;
      values.push(`%${location}%`);
    }

    querySting += ` ORDER BY j.created_at DESC`;

    const jobs = [...(await sql.query(querySting, values))];

    await redisClient.setEx(cacheKey, 300, JSON.stringify(jobs));

    return res.status(200).json({
      success: true,
      count: jobs.length,
      fromCache: false,
      jobs,
    });
  },
);

export const getJobById = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const cacheKey = `job:${job_id}`;
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        job: JSON.parse(cached),
      });
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

    await redisClient.setEx(cacheKey, 600, JSON.stringify(job));

    return res.status(200).json({
      success: true,
      fromCache: false,
      job,
    });
  },
);

export const applyJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return next(new ErrorHandler(403, "Unauthorized"));
    }
    if (user.role !== "jobseeker") {
      return next(new ErrorHandler(403, "Something went wrong"));
    }

    const applicant_id = user.user_id;
    const resume = user?.resume;

    if (!resume) {
      return next(new ErrorHandler(403, "Add at least one resume"));
    }

    const { jobId } = req.body;
    if (!jobId) {
      return next(new ErrorHandler(403, "Not Found!!!"));
    }

    const [job] = await sql`
  SELECT is_active FROM jobs WHERE job_id=${jobId}`;

    if (!job?.is_active) {
      return next(new ErrorHandler(403, "Not Found!!!"));
    }

    const current = Date.now();
    const subTime = req.user?.subscription
      ? new Date(req.user.subscription).getTime()
      : 0;
    const isSubscribed = subTime > current;

    let newApplication;
    try {
      [newApplication] = await sql`
  INSERT INTO applications (
    job_id,
    applicant_id,
    applicant_email,
    resume,
    subscribed
  )
  VALUES (
    ${jobId},
    ${applicant_id},
    ${user.email},
    ${resume},
    ${isSubscribed}
  )
  RETURNING *
`;
    } catch (error: any) {
      if (error.code === "23505") {
        throw new ErrorHandler(403, "Something went wrong!!!");
      }
      throw error;
    }

    return res.status(200).json({
      message: "Application submitted successfully",
      application: newApplication,
    });
  },
);

export const getApplications = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "jobseeker") {
      return next(
        new ErrorHandler(403, "Only jobseekers can view applications"),
      );
    }

    const applicant_id = req.user.user_id;

    const applications = await sql`
      SELECT
        a.application_id,
        a.status,
        a.applied_at,
        a.subscribed,

        j.job_id,
        j.title AS job_title,
        j.salary AS job_salary,
        j.location AS job_location,
        j.job_type,
        j.work_location,
        j.is_active,

        c.company_id,
        c.name AS company_name,
        c.logo AS company_logo

      FROM applications a

      INNER JOIN jobs j
        ON a.job_id = j.job_id

      INNER JOIN companies c
        ON j.company_id = c.company_id

      WHERE a.applicant_id = ${applicant_id}

      ORDER BY a.applied_at DESC
    `;
    if (!applications) {
      return next(new ErrorHandler(404, "No applications found"));
    }
    return res.status(200).json({
      success: true,
      count: applications.length,
      applications,
    });
  },
);

export const getApplicationsByRecruiterJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can access applications"),
      );
    }

    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const applications = await sql`
  SELECT
    a.application_id,
    a.status,
    a.applied_at,
    a.subscribed,
    a.resume,

    u.user_id,
    u.name,
    u.email,
    u.phone_number,
    u.bio,
    u.profile_pic,

    j.job_id,
    j.title

  FROM applications a

  INNER JOIN users u
    ON a.applicant_id = u.user_id

  INNER JOIN jobs j
    ON a.job_id = j.job_id
    AND j.posted_by_recruiter_id = ${req.user.user_id}

  WHERE a.job_id = ${job_id}

  ORDER BY
    a.subscribed DESC,
    a.applied_at ASC
`;

    if (applications.length === 0) {
      return next(new ErrorHandler(404, "Job not found or access denied"));
    }

    return res.status(200).json({
      success: true,
      count: applications.length,
      applications,
    });
  },
);

const APPLICATION_STATUSES = ["Submitted", "Rejected", "Hired"] as const;
type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const updateJobApplication = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can update application status"),
      );
    }

    const application_id = sanitizePositiveInt(
      req.params.application_id,
      "Application ID",
    );

    const { status } = req.body;
    if (!status) {
      return next(new ErrorHandler(400, "Status is required"));
    }
    if (!APPLICATION_STATUSES.includes(status as ApplicationStatus)) {
      return next(
        new ErrorHandler(
          400,
          `status must be one of: ${APPLICATION_STATUSES.join(", ")}`,
        ),
      );
    }

    const [application] = await sql`
      SELECT
        a.application_id,
        a.status          AS current_status,
        a.applicant_email,
        u.name            AS applicant_name,
        j.title           AS job_title,
        j.is_active,
        c.name            AS company_name,
        c.recruiter_id
      FROM applications a
      INNER JOIN users u      ON a.applicant_id  = u.user_id
      INNER JOIN jobs j       ON a.job_id        = j.job_id
      INNER JOIN companies c  ON j.company_id    = c.company_id
      WHERE a.application_id = ${application_id}
      LIMIT 1
    `;

    if (!application) {
      return next(new ErrorHandler(404, "Application not found"));
    }

    if (application.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(
          403,
          "You are not authorized to update this application",
        ),
      );
    }

    if (!application.is_active) {
      return next(
        new ErrorHandler(400, "Cannot update application for an inactive job"),
      );
    }

    if (application.current_status === status) {
      return res.status(200).json({
        success: true,
        message: "Application status is already up to date",
      });
    }

    const TERMINAL_STATUSES: ApplicationStatus[] = ["Hired", "Rejected"];
    if (
      TERMINAL_STATUSES.includes(
        application.current_status as ApplicationStatus,
      )
    ) {
      return next(
        new ErrorHandler(
          409,
          `Cannot change status: application is already ${application.current_status}`,
        ),
      );
    }

    const [updated] = await sql`
      UPDATE applications
      SET status = ${status as ApplicationStatus}
      WHERE application_id = ${application_id}
      RETURNING
        application_id,
        job_id,
        applicant_id,
        applicant_email,
        status,
        applied_at,
        subscribed
    `;
    if (!updated) {
      return next(
        new ErrorHandler(
          409,
          "Application status is already final or unchanged",
        ),
      );
    }

    kafka.publish("send-mail", {
      to: application.applicant_email,
      subject: "Application Status Update",
      html: applicationStatusTemplate({
        applicantName: application.applicant_name,
        jobTitle: application.job_title,
        companyName: application.company_name,
      }),
    }).catch((err) =>
      console.error("[Kafka] Publish failed (non-fatal):", err),
    );

    return res.status(200).json({
      success: true,
      message: "Application status updated successfully",
      application: {
        ...updated,
        job_title: application.job_title,
        company_name: application.company_name,
      },
    });
  },
);
