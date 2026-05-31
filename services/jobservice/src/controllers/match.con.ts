import { Response } from "express";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";

const UTILS_SERVICE_URL = process.env.UTILS_SERVICE_URL;

function buildJobPayload(job: {
  title: string;
  description: string;
  salary: number | null;
  location: string | null;
  job_type: string | null;
  work_location: string | null;
  role: string | null;
  company_name: string | null;
  [key: string]: unknown;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: job.title,
    description: job.description,
  };
  if (job.salary != null) payload.salary = job.salary;
  if (job.location) payload.location = job.location;
  if (job.job_type) payload.job_type = job.job_type;
  if (job.work_location) payload.work_location = job.work_location;
  if (job.role) payload.role = job.role;
  if (job.company_name) payload.company_name = job.company_name;
  return payload;
}

const setSSEHeaders = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

export const analyzeJobMatch = TryCatch(async (req: AuthRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    throw new ErrorHandler(401, "Authentication required");
  }

  if (user.role !== "jobseeker") {
    throw new ErrorHandler(403, "Only job seekers can analyze job matches");
  }

  const jobId = parseInt(req.params.jobId as string, 10);
  if (isNaN(jobId) || jobId <= 0) {
    throw new ErrorHandler(400, "Invalid job ID");
  }

  const [userRow] = await sql`
    SELECT resume FROM users WHERE user_id = ${user.user_id} LIMIT 1
  `;
  if (!userRow) {
    throw new ErrorHandler(404, "User not found");
  }
  if (!userRow.resume) {
    throw new ErrorHandler(400, "No resume found. Please upload a resume first.");
  }

  const [job] = await sql`
    SELECT
      j.title,
      j.description,
      j.salary,
      j.location,
      j.job_type,
      j.work_location,
      j.role,
      c.name AS company_name
    FROM jobs j
    JOIN companies c ON j.company_id = c.company_id
    WHERE j.job_id = ${jobId}
    LIMIT 1
  `;
  if (!job) {
    throw new ErrorHandler(404, "Job not found");
  }

  if (!UTILS_SERVICE_URL) {
    throw new ErrorHandler(500, "Utils service URL not configured");
  }

  const controller = new AbortController();
  const timeoutMs = 60000;

  req.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${UTILS_SERVICE_URL}/ai/analyze-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeUrl: userRow.resume,
        job: buildJobPayload(job as Parameters<typeof buildJobPayload>[0]),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown error");
      throw new ErrorHandler(
        response.status,
        `Analysis failed: ${response.status} - ${body}`,
      );
    }

    setSSEHeaders(res);

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ErrorHandler(500, "No response stream from analysis service");
    }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (controller.signal.aborted && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ status: "error", message: "Request was cancelled or timed out" })}\n\n`,
      );
      res.end();
      return;
    }

    throw error;
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});
