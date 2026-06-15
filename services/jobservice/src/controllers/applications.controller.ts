import { Response, NextFunction } from "express";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { withCache } from "@jtrack/shared/redis/helpers";
import { kafka } from "../kafka.js";
import { redisClient } from "../redis.js";
import { applicationStatusTemplate } from "../utils/template.js";
import {
  CACHE_KEYS,
  sanitizePositiveInt,
} from "./utils.js";

const APPLICATION_STATUSES = ["Submitted", "Rejected", "Hired"] as const;
type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const applyJob = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return next(new ErrorHandler(403, "Unauthorized"));
    }
    if (user.role !== "jobseeker") {
      return next(new ErrorHandler(403, "Only jobseekers can apply for jobs"));
    }

    const applicant_id = user.user_id;
    const resume = user?.resume;

    const jobId = Number(req.body.jobId);
    if (!jobId || isNaN(jobId)) {
      return next(new ErrorHandler(403, "Not Found!!!"));
    }

    const applicant = await prisma.user.findFirst({
      where: { user_id: applicant_id },
      select: { email: true },
    });
    if (!applicant) {
      return next(new ErrorHandler(404, "Applicant not found"));
    }
    const applicant_email = applicant.email;

    const job = await prisma.job.findFirst({
      where: { job_id: jobId },
      select: { is_active: true },
    });

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
      newApplication = await prisma.application.create({
        data: {
          job_id: jobId,
          applicant_id,
          applicant_email,
          subscribed: isSubscribed,
          ...(resume && { resume }),
        } as any,
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        throw new ErrorHandler(409, "You have already applied for this job");
      }
      throw error;
    }

    try {
      await redisClient.del(CACHE_KEYS.applications(applicant_id));
    } catch (err) {
      console.error("[Redis] Cache invalidation error (non-fatal):", err);
    }

    kafka.publish("job-events", {
      type: "job.applied",
      job_id: newApplication.job_id,
      applicant_id,
      applied_at: new Date().toISOString(),
    }).catch((err: unknown) =>
      console.error("[Kafka] Failed to publish job.applied event:", err),
    );

    return res.status(200).json({
      success: true,
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

    const { data: applications, fromCache } = await withCache(
      redisClient,
      CACHE_KEYS.applications(applicant_id),
      300,
      async () => {
        const applications = await prisma.application.findMany({
          where: { applicant_id },
          select: {
            application_id: true,
            status: true,
            applied_at: true,
            subscribed: true,
            job: {
              select: {
                job_id: true,
                title: true,
                salary: true,
                location: true,
                job_type: true,
                work_location: true,
                is_active: true,
                company: {
                  select: {
                    company_id: true,
                    name: true,
                    logo: true,
                  },
                },
              },
            },
          },
          orderBy: { applied_at: "desc" },
        });

        if (applications.length === 0) {
          throw new ErrorHandler(404, "No applications found");
        }

        return applications.map((a) => ({
          application_id: a.application_id,
          status: a.status,
          applied_at: a.applied_at,
          subscribed: a.subscribed,
          job_id: a.job.job_id,
          job_title: a.job.title,
          job_salary: a.job.salary,
          job_location: a.job.location,
          job_type: a.job.job_type,
          work_location: a.job.work_location,
          is_active: a.job.is_active,
          company_id: a.job.company.company_id,
          company_name: a.job.company.name,
          company_logo: a.job.company.logo,
        }));
      },
    );

    return res.status(200).json({
      success: true,
      count: applications.length,
      applications,
      ...(fromCache && { fromCache }),
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
    const recruiter_id = req.user.user_id;

    const { data: applications, fromCache } = await withCache(
      redisClient,
      CACHE_KEYS.applicationsByJob(job_id),
      300,
      async () => {
        const applications = await prisma.application.findMany({
          where: {
            job_id,
            job: { posted_by_recruiter_id: recruiter_id },
          },
          select: {
            application_id: true,
            status: true,
            applied_at: true,
            subscribed: true,
            resume: true,
            applicant_id: true,
            job: {
              select: {
                job_id: true,
                title: true,
              },
            },
          },
          orderBy: [
            { subscribed: "desc" },
            { applied_at: "asc" },
          ],
        });

        if (applications.length === 0) {
          throw new ErrorHandler(404, "Job not found or access denied");
        }

        const userIds = applications.map((a) => a.applicant_id);
        const users = await prisma.user.findMany({
          where: { user_id: { in: userIds } },
          select: {
            user_id: true,
            name: true,
            email: true,
            phone_number: true,
            bio: true,
            profile_pic: true,
          },
        });
        const userMap = new Map(users.map((u) => [u.user_id, u]));

        return applications.map((a) => {
          const u = userMap.get(a.applicant_id);
          return {
            application_id: a.application_id,
            status: a.status,
            applied_at: a.applied_at,
            subscribed: a.subscribed,
            resume: a.resume,
            user_id: u?.user_id,
            name: u?.name,
            email: u?.email,
            phone_number: u?.phone_number,
            bio: u?.bio,
            profile_pic: u?.profile_pic,
            job_id: a.job.job_id,
            title: a.job.title,
          };
        });
      },
    );

    return res.status(200).json({
      success: true,
      count: applications.length,
      applications,
      ...(fromCache && { fromCache }),
    });
  },
);

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

    const app = await prisma.application.findFirst({
      where: { application_id },
      select: {
        application_id: true,
        status: true,
        applicant_email: true,
        applicant_id: true,
        job: {
          select: {
            job_id: true,
            title: true,
            is_active: true,
            company: { select: { name: true, recruiter_id: true } },
          },
        },
      },
    });

    if (!app) {
      return next(new ErrorHandler(404, "Application not found"));
    }

    const applicant = await prisma.user.findFirst({
      where: { user_id: app.applicant_id },
      select: { name: true },
    });

    const application = {
      ...app,
      current_status: app.status,
      applicant_name: applicant?.name ?? "Unknown",
      job_id: app.job.job_id,
      job_title: app.job.title,
      is_active: app.job.is_active,
      company_name: app.job.company.name,
      recruiter_id: app.job.company.recruiter_id,
    };

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

    const updated = await prisma.application.update({
      where: { application_id },
      data: { status: status as any },
      select: {
        application_id: true,
        job_id: true,
        applicant_id: true,
        applicant_email: true,
        status: true,
        applied_at: true,
        subscribed: true,
      },
    });

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

    kafka.publish("job-events", {
      type: "application.status_changed",
      job_id: application.job_id,
      application_id,
      new_status: status,
      timestamp: new Date().toISOString(),
    }).catch((err: unknown) =>
      console.error("[Kafka] Failed to publish application.status_changed event:", err),
    );

    try {
      await redisClient.del(CACHE_KEYS.applicationsByJob(application.job_id));
      await redisClient.del(CACHE_KEYS.applications(updated.applicant_id));
    } catch (err) {
      console.error("[Redis] Cache invalidation error (non-fatal):", err);
    }

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
