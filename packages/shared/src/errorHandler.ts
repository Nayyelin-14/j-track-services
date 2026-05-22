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
  const message = err.message || "Internal Server Error";
  return res.status(statusCode).json({ success: false, message });
};
