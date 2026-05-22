import { Request, Response, NextFunction } from "express";

type Handler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<any>;

export const TryCatch =
  (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch (error: any) {
      const status = error?.statusCode || 500;
      const message = error?.message || "Internal Server Error";
      const rawResponse = error?.rawResponse;
      res
        .status(status)
        .json({ success: false, message, ...(rawResponse && { rawResponse }) });
    }
  };
