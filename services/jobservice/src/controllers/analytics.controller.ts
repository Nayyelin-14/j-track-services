import { Response, NextFunction } from "express";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { sanitizePositiveInt } from "./utils.js";

export const getJobAnalytics = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(new ErrorHandler(403, "Only recruiters can view analytics"));
    }

    const job_id = sanitizePositiveInt(req.params.job_id, "Job ID");

    const [job] = await sql`
      SELECT
        j.job_id,
        j.title,
        j.is_active,
        j.created_at,
        c.recruiter_id
      FROM jobs j
      INNER JOIN companies c ON j.company_id = c.company_id
      WHERE j.job_id = ${job_id}
      LIMIT 1
    `;

    if (!job) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (job.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You do not own this job"));
    }

    const daily = await sql`
      SELECT
        date,
        views,
        applications,
        status_changes
      FROM job_analytics
      WHERE job_id = ${job_id}
      ORDER BY date DESC
      LIMIT 90
    `;

    const totals = await sql`
      SELECT
        COALESCE(SUM(views), 0)::int         AS total_views,
        COALESCE(SUM(applications), 0)::int  AS total_applications,
        COALESCE(SUM(status_changes), 0)::int AS total_status_changes
      FROM job_analytics
      WHERE job_id = ${job_id}
    `;

    return res.status(200).json({
      success: true,
      job_id: job.job_id,
      title: job.title,
      is_active: job.is_active,
      created_at: job.created_at,
      analytics: {
        ...totals[0],
        daily,
      },
    });
  },
);
