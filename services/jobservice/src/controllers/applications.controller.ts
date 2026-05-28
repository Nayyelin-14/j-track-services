import { Response, NextFunction } from "express";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { withCache } from "@jtrack/shared/redis/helpers";
import { kafka } from "../kafka.js";
import { redisClient } from "../redis.js";
import { applicationStatusTemplate } from "../utils/template.js";
import {
  AuthRequest,
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

    try {
      await redisClient.del(CACHE_KEYS.applications(applicant_id));
    } catch (err) {
      console.error("[Redis] Cache invalidation error (non-fatal):", err);
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

    const { data: applications, fromCache } = await withCache(
      redisClient,
      CACHE_KEYS.applications(applicant_id),
      300,
      async () => {
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
          throw new ErrorHandler(404, "No applications found");
        }

        return applications;
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
            AND j.posted_by_recruiter_id = ${recruiter_id}

          WHERE a.job_id = ${job_id}

          ORDER BY
            a.subscribed DESC,
            a.applied_at ASC
        `;

        if (applications.length === 0) {
          throw new ErrorHandler(404, "Job not found or access denied");
        }

        return applications;
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

    const [application] = await sql`
      SELECT
        a.application_id,
        a.status          AS current_status,
        a.applicant_email,
        u.name            AS applicant_name,
        j.job_id,
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
