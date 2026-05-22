import { Router } from "express";
import rateLimit from "express-rate-limit";
import { careerGuidanceByAI, generateTest } from "../controllers/ai";
import { analyzeMatch } from "../controllers/match";

const router = Router();

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const careerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Rate limit exceeded for AI guidance. Please wait." },
  standardHeaders: true,
  legacyHeaders: false,
});

const matchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Rate limit exceeded for match analysis. Please wait." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/generate", testLimiter, generateTest);
router.post("/career-guidance", careerLimiter, careerGuidanceByAI);
router.post("/analyze-match", matchLimiter, analyzeMatch);

export default router;
