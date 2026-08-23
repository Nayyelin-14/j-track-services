import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { isAuthenticated } from "@jtrack/shared/isauthenticated";
import { careerChatByAI, generateTest } from "../controllers/ai.js";
import { analyzeMatch } from "../controllers/match.js";
import { listModels } from "../controllers/models.js";

const router = Router();

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Conversational usage needs more headroom than one-shot analysis.
// Keyed per authenticated user (falls back to IP) so one user can never
// exhaust another user's Career AI budget. Runs AFTER isAuthenticated.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string =>
    req.user?.user_id != null
      ? `user:${req.user.user_id}`
      : `ip:${ipKeyGenerator(req.ip ?? "")}`,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message: "Rate limit exceeded for Career AI. Please wait a moment.",
    });
  },
});

const matchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Rate limit exceeded for match analysis. Please wait." },
  standardHeaders: true,
  legacyHeaders: false,
});

const modelsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests for model data." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Career AI is a seeker-facing feature — reuse the shared auth pattern
 * and the inline role-check style used across jobs/user controllers. */
function requireSeeker(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "jobseeker") {
    res.status(403).json({ success: false, code: "FORBIDDEN", message: "Forbidden" });
    return;
  }
  next();
}

router.post("/generate", testLimiter, generateTest);
// /analyze-match stays open here BY DESIGN: the jobs service calls it
// server-to-server after authenticating the user on its own route
// (services/jobservice/src/routes/job.route.ts). Adding cookie auth would
// break that internal hop.
router.post("/analyze-match", matchLimiter, analyzeMatch);
router.get("/models", isAuthenticated, modelsLimiter, listModels);
router.post("/chat", isAuthenticated, requireSeeker, chatLimiter, careerChatByAI);

export default router;
