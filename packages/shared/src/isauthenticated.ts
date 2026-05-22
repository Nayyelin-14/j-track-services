import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { sql } from "./db";
import { signAccessToken } from "./token";
import { accessCookieOptions } from "./cookies";

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
      );
      (req as any).user = decoded;
      return next();
    } catch {
      // fall through to refresh token
    }
  }

  if (!refreshToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const decoded: any = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET as string,
    );

    const [user] = await sql`
      SELECT user_id, role, refresh_token
      FROM users
      WHERE user_id = ${decoded.user_id}
      LIMIT 1
    `;

    if (!user || user.refresh_token !== refreshToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const newAccessToken = signAccessToken({
      user_id: user.user_id,
      role: user.role,
    });

    res.cookie("accessToken", newAccessToken, accessCookieOptions);

    (req as any).user = { user_id: user.user_id, role: user.role };
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
