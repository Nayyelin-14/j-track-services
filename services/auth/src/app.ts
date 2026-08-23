import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth.js";
import { errorMiddleware } from "@jtrack/shared/errorHandler";
import { requestLogger } from "@jtrack/shared/logger";
import { correlationMiddleware } from "@jtrack/shared/kafka/correlation";

const app = express();

// Single nginx reverse proxy in front of this service — trust exactly one
// hop so req.ip reflects the real client address (rate limiting keys on it).
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(correlationMiddleware());
app.use(requestLogger);
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Test runs make many requests from one IP; mirror the auth limiter's
  // relaxed ceiling so E2E suites aren't throttled by unrelated endpoints.
  max: process.env.NODE_ENV === "test" ? 2000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 1000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again later" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/verify-email", authLimiter);
app.use("/api/auth/resend-verification", authLimiter);

app.use("/api/auth", authRoutes);

app.use(errorMiddleware);

export default app;
