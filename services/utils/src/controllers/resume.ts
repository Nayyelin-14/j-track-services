import { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  validateResumeFile,
  MAX_PDF_SIZE_BYTES,
} from "../validators/resume.js";
import resumeService, {
  ResumeError,
} from "../services/resume.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE_BYTES, files: 1 },
  // NOTE: file type/size validation intentionally happens in-controller
  // (validateResumeFile) so every rejection flows through the SSE error
  // path instead of multer's plain-HTTP error handler.
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
  let terminalSent = false;

  const sendTerminal = (event: Record<string, unknown>): void => {
    if (terminalSent || res.writableEnded) return;
    terminalSent = true;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  };

  const abortController = new AbortController();

  setSSEHeaders(res);

  // "close" on the RESPONSE fires when the client connection drops early.
  // (req "close" also fires when a multipart body finishes streaming, which
  // would falsely mark healthy requests as aborted.)
  res.on("close", () => {
    if (!res.writableEnded) {
      console.info(`[SSE] Resume client disconnected: ${req.ip}`);
      abortController.abort();
    }
  });

  try {
    if (!req.file) {
      sendTerminal({
        status: "error",
        code: "EMPTY_FILE",
        message: "No PDF uploaded. Use field name: resume",
      });
      return;
    }

    try {
      validateResumeFile(req.file);
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendTerminal({
          status: "error",
          code: "INVALID_FILE",
          message: err.issues[0]?.message ?? "Invalid file",
        });
        return;
      }
      throw err;
    }

    await resumeService.streamResumeAnalysis(
      req.file.buffer,
      res,
      abortController.signal,
    );
  } catch (error) {
    const aborted = abortController.signal.aborted;
    if (aborted) {
      // Client is gone; upstream work is best-effort abandoned. Still make
      // sure the socket reaches a terminal state.
      sendTerminal({ status: "error", code: "ABORTED" });
      return;
    }

    let code = "INTERNAL_ERROR";
    let message = "Unexpected error occurred";
    let errors: string[] | undefined;

    if (error instanceof ResumeError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof z.ZodError) {
      code = "VALIDATION_ERROR";
      message = "Validation failed";
      errors = error.issues.map(
        (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`,
      );
    } else {
      // Never leak parser/provider internals to the client.
      console.error("[ResumeAnalyze] Unexpected error:", error);
    }

    console.error("[ResumeAnalyze] Error:", code, message);
    sendTerminal({ status: "error", code, message, ...(errors && { errors }) });
  }
};
