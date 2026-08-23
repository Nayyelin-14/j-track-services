import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { errorMiddleware } from "@jtrack/shared/errorHandler";
import { requestLogger } from "@jtrack/shared/logger";
import { correlationMiddleware } from "@jtrack/shared/kafka/correlation";

const app = express();

// Single nginx reverse proxy in front of this service — trust exactly one
// hop so req.ip reflects the real client address (rate limiting keys on it).
app.set("trust proxy", 1);

// Chat requests are tiny bounded JSON (validator caps ~170KB); parse them
// under a tight limit BEFORE the global 50mb parser sees them. A matched
// body-parser marks req._body, so the global parser skips these.
app.use("/api/utils/ai/chat", express.json({ limit: "256kb" }));

app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(correlationMiddleware());
app.use(requestLogger);
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);

export { errorMiddleware };

export default app;
