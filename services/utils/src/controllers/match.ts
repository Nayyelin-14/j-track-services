import { Request, Response } from "express";
import { z } from "zod";
import matchService from "../services/match.js";
import { analyzeMatchSchema } from "../validators/match.js";

const setSSEHeaders = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

export const analyzeMatch = async (req: Request, res: Response): Promise<void> => {
  const controller = new AbortController();
  const signal = controller.signal;

  req.on("close", () => {
    if (!res.writableEnded) {
      console.info("[Match] Client disconnected");
      controller.abort();
    }
  });

  setSSEHeaders(res);

  try {
    const input = analyzeMatchSchema.parse(req.body);

    const job = input.job as unknown as import("../services/match").JobDetails;

    await matchService.streamMatchAnalysis(
      input.resumeUrl,
      job,
      res,
      signal,
    );
  } catch (error) {
    if (signal.aborted) return;

    if (error instanceof z.ZodError) {
      const errors = error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ status: "error", message: "Validation failed", errors })}\n\n`,
        );
      }
    } else {
      const message = error instanceof Error ? error.message : "Unexpected error";
      console.error("[Match] Error:", message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ status: "error", message })}\n\n`,
        );
      }
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
};
