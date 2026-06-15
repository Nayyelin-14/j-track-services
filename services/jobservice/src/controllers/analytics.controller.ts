import { Response, NextFunction } from "express";
import { prisma } from "@jtrack/shared/db";
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

    const job = await prisma.job.findFirst({
      where: { job_id },
      select: {
        job_id: true,
        title: true,
        is_active: true,
        created_at: true,
        company: { select: { recruiter_id: true } },
      },
    });

    if (!job) {
      return next(new ErrorHandler(404, "Job not found"));
    }

    if (job.company.recruiter_id !== req.user.user_id) {
      return next(new ErrorHandler(403, "You do not own this job"));
    }

    const daily = await prisma.jobAnalytics.findMany({
      where: { job_id },
      select: {
        date: true,
        views: true,
        applications: true,
        status_changes: true,
      },
      orderBy: { date: "desc" },
      take: 90,
    });

    const aggregated = await prisma.jobAnalytics.aggregate({
      where: { job_id },
      _sum: { views: true, applications: true, status_changes: true },
    });
    const totals = {
      total_views: aggregated._sum.views ?? 0,
      total_applications: aggregated._sum.applications ?? 0,
      total_status_changes: aggregated._sum.status_changes ?? 0,
    };

    return res.status(200).json({
      success: true,
      job_id: job.job_id,
      title: job.title,
      is_active: job.is_active,
      created_at: job.created_at,
      analytics: {
        ...totals,
        daily,
      },
    });
  },
);
