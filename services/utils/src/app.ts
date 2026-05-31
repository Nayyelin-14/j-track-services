import express from "express";
import helmet from "helmet";
import cors from "cors";
import { errorMiddleware } from "@jtrack/shared/errorHandler";

const app = express();

app.use(helmet());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);

export { errorMiddleware };

export default app;
