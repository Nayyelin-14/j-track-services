import { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  validateResumeFile,
  MAX_PDF_SIZE_BYTES,
} from "../validators/resume";
import resumeService from "../services/resume";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed"));
    }
    cb(null, true);
  },
});

export const uploadMiddleware = upload.single("resume");

const setSSEHeaders = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

export const analyzeResume = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const controller = new AbortController();

  setSSEHeaders(res);

  req.on("close", () => {
    if (!res.writableEnded) {
      console.info(`[SSE] Resume client disconnected: ${req.ip}`);
      controller.abort();
    }
  });

  try {
    if (!req.file) {
      res.write(
        `data: ${JSON.stringify({ status: "error", message: "No PDF uploaded. Use field name: resume" })}\n\n`,
      );
      res.end();
      return;
    }

    validateResumeFile(req.file);

    await resumeService.streamResumeAnalysis(
      req.file.buffer,
      res,
    );
  } catch (error) {
    if (controller.signal.aborted) return;

    let message = "Unexpected error occurred";
    let errors: string[] | undefined;

    if (error instanceof z.ZodError) {
      errors = error.issues.map(
        (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      message = "Validation failed";
    } else if (error instanceof Error) {
      message = error.message;
    }

    console.error("[ResumeAnalyze] Error:", message);

    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ status: "error", message, ...(errors && { errors }) })}\n\n`,
      );
      res.end();
    }
  }
};
