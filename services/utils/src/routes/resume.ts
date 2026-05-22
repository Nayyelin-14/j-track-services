import { Router } from "express";
import rateLimit from "express-rate-limit";
import { analyzeResume, uploadMiddleware } from "../controllers/resume";

const router = Router();

const resumeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: {
    error: "Too many resume analysis requests. Please wait a moment.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  "/analyze",
  resumeLimiter,
  uploadMiddleware,
  analyzeResume,
);

export default router;
