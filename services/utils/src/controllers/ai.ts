import { Request, Response } from "express";
import { z } from "zod";
import { TryCatch } from "@jtrack/shared/tryCatch";
import AIConfig from "../config/ai.js";
import careerChatService, { StreamStalledError, DEADLINE_MESSAGE } from "../services/career.js";
import {
  careerGenerationLimits,
} from "../services/generation-limits.js";
import { validateCareerChat } from "../validators/career-chat.js";
import { currentCorrelationId } from "@jtrack/shared/kafka/correlation";

const setSSEHeaders = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

export const generateTest = TryCatch(async (_req: Request, res: Response) => {
  const ai = AIConfig.getInstance();

  const response = await ai.chat.completions.create({
    model: AIConfig.getModel(),
    messages: [{ role: "user", content: "Explain how AI works in a few words" }],
  });

  res.json({
    success: true,
    result: response.choices[0]?.message?.content,
    model: AIConfig.getModel(),
  });
});

/** Safe generation log — metadata only, never conversation content. */
function logCareerChat(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ tag: "CareerChat", correlationId: currentCorrelationId(), ...fields }));
}

export const careerChatByAI = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const userId = req.user!.user_id;
  const selectedModel = typeof req.body?.model === "string" ? req.body.model : undefined;

  // Concurrency guards run BEFORE any SSE byte and BEFORE NIM: one active
  // generation per user, bounded total. Rejections are plain JSON so the
  // client gets a real HTTP status plus a stable machine-readable code.
  const acquire = careerGenerationLimits.tryAcquire(userId);
  if (acquire === "user_busy") {
    logCareerChat({ userId, event: "concurrency_rejected", scope: "user" });
    res.status(409).json({
      success: false,
      code: "CONCURRENCY_REJECTED",
      message: "You already have a Career AI response generating. Please wait for it to finish.",
    });
    return;
  }
  if (acquire === "at_capacity") {
    logCareerChat({ userId, event: "concurrency_rejected", scope: "global" });
    res.status(503).json({
      success: false,
      code: "UPSTREAM_UNAVAILABLE",
      message: "Career AI is at capacity right now. Please try again in a moment.",
    });
    return;
  }

  const controller = new AbortController();
  // Client disconnect detection: IncomingMessage "close" does NOT fire
  // reliably for fully-consumed POST bodies. ServerResponse "close" fires
  // whenever the underlying socket terminates; skip the normal-end case.
  const abortIfClientGone = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", abortIfClientGone);
  // Heartbeat comments keep intermediaries from idling out the stream and
  // surface dead peer connections via write failures.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": hb\n\n");
  }, 15000);

  setSSEHeaders(res);

  let terminationReason = "error";
  let errorCode = "UPSTREAM_UNAVAILABLE";

  try {
    const input = validateCareerChat(req.body);
    const summary = await careerChatService.streamCareerChat(input, res, controller.signal);
    if (!summary) {
      // Client disconnected mid-generation — service exited silently.
      terminationReason = "aborted";
      logCareerChat({ userId, event: "generation", terminationReason, selectedModel: input.model ?? null });
      return;
    }
    terminationReason = "completed";
    logCareerChat({
      userId,
      event: "generation",
      terminationReason,
      selectedModel: input.model ?? null,
      modelUsed: summary.modelUsed,
      latencyMs: summary.latencyMs,
      usage: summary.usage,
      fallbacks: summary.fallbacks,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      terminationReason = "aborted";
      logCareerChat({ userId, event: "generation", terminationReason, selectedModel: selectedModel ?? null });
      return;
    }
    if (error instanceof StreamStalledError) {
      terminationReason = "stalled";
      errorCode = "UPSTREAM_TIMEOUT";
    } else if (error instanceof Error && error.message === DEADLINE_MESSAGE) {
      terminationReason = "deadline";
      errorCode = "UPSTREAM_TIMEOUT";
    } else if ((error as { status?: number }).status === 429) {
      terminationReason = "rate_limited";
      errorCode = "RATE_LIMITED";
    }
    logCareerChat({
      userId,
      event: "generation",
      terminationReason,
      selectedModel: selectedModel ?? null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });

    if (!res.writableEnded) {
      if (error instanceof z.ZodError) {
        const messages = error.issues.map(
          (issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`,
        );
        res.write(`data: ${JSON.stringify({ status: "error", code: "VALIDATION_ERROR", errors: messages })}\n\n`);
      } else {
        // Never leak provider internals to the seeker.
        res.write(
          `data: ${JSON.stringify({
            status: "error",
            code: errorCode,
            message:
              errorCode === "RATE_LIMITED"
                ? "The AI service is very busy right now. Please try again in a moment."
                : "I couldn't generate a response right now. Please try again in a moment.",
          })}\n\n`,
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
    res.off("close", abortIfClientGone);
    careerGenerationLimits.release(userId);
    if (!res.writableEnded) res.end();
  }
};
