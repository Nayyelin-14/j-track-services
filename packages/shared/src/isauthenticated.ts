import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./db";
import { signAccessToken } from "./token";
import { accessCookieOptions } from "./cookies";

declare global {
  namespace Express {
    interface Request {
      user?: {
        user_id: number;
        name?: string;
        email?: string;
        password?: string;
        phone_number?: string;
        role?: string;
        bio?: string | null;
        resume?: string | null;
        refresh_token?: string | null;
        resume_public_id?: string | null;
        profile_pic?: string | null;
        profile_pic_public_id?: string | null;
        created_at?: Date;
        subscription?: Date | null;
      };
    }
  }
}

export const isAuthenticated = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const accessToken = req.cookies?.accessToken;
  const refreshToken = req.cookies?.refreshToken;
  if (accessToken) {
    try {
      const decoded = jwt.verify(
        accessToken,
        process.env.JWT_ACCESS_SECRET as string,
      ) as { user_id: number; role: string };
      req.user = decoded;
      return next();
    } catch {
    }
  }

  if (!refreshToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET as string,
    ) as { user_id: number };

    const user = await prisma.user.findFirst({
      where: { user_id: decoded.user_id },
      select: { user_id: true, role: true, refresh_token: true },
    });

    if (!user || user.refresh_token !== refreshToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const newAccessToken = signAccessToken({
      user_id: user.user_id,
      role: user.role,
    });

    res.cookie("accessToken", newAccessToken, accessCookieOptions);

    req.user = { user_id: user.user_id, role: user.role };
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
