import { Request, Response, NextFunction } from "express";

export class ErrorHandler extends Error {
  statusCode: number;
  rawResponse?: string;

  constructor(statusCode: number, message: string, rawResponse?: string) {
    super(message);
    this.statusCode = statusCode;
    this.rawResponse = rawResponse;
    Object.setPrototypeOf(this, ErrorHandler.prototype);
  }
}

export const errorMiddleware = (
  err: ErrorHandler,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Only intentional, typed errors may reach clients. Unexpected internal
  // errors (Prisma, network, etc.) can embed stack traces, file paths and
  // schema details — log them server-side and return a generic message.
  if (!err.statusCode) {
    console.error(`[Unhandled] ${req.method} ${req.path}:`, err);
    message = "Internal Server Error";
  }

  return res.status(statusCode).json({ success: false, message });
};
