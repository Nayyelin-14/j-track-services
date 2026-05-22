import { Request, Response } from "express";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { z } from "zod";
import AIConfig from "../config/ai";
import careerService from "../services/career";
import { validateCareerGuidance } from "../validators/career";

const setSSEHeaders = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

export const generateTest = TryCatch(async (_req: Request, res: Response) => {
  const ai = AIConfig.getInstance();

  const response = await ai.models.generateContent({
    model: AIConfig.getModel(),
    contents: "Explain how AI works in a few words",
  });

  res.json({
    success: true,
    result: response.text,
    model: AIConfig.getModel(),
  });
});

export const careerGuidanceByAI = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const controller = new AbortController();

  req.on("close", () => {
    console.info(`[SSE] Client disconnected: ${req.ip}`);
    controller.abort();
  });

  setSSEHeaders(res);

  try {
    const input = validateCareerGuidance(req.body);

    await careerService.streamCareerGuidance(input, res, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;

    if (error instanceof z.ZodError) {
      const messages = error.issues.map(
        (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ status: "error", errors: messages })}\n\n`,
        );
      }
    } else if (error instanceof ErrorHandler) {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ status: "error", message: error.message })}\n\n`,
        );
      }
    } else {
      const message =
        error instanceof Error ? error.message : "Unexpected error";
      console.error("[CareerGuidance] Error:", message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ status: "error", message })}\n\n`);
      }
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
};
