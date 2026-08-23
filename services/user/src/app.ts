import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import userRoutes from "./routes/user.routes.js";
import { errorMiddleware } from "@jtrack/shared/errorHandler";
import { requestLogger } from "@jtrack/shared/logger";
import { correlationMiddleware } from "@jtrack/shared/kafka/correlation";

const app = express();

// Single nginx reverse proxy in front of this service — trust exactly one
// hop so req.ip reflects the real client address (rate limiting keys on it).
app.set("trust proxy", 1);

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(helmet());

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" },
});
app.use(globalLimiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(correlationMiddleware());
app.use(requestLogger);

app.use("/api/users", userRoutes);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use(errorMiddleware);

export default app;
