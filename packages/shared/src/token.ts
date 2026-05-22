import jwt from "jsonwebtoken";

interface TokenPayload {
  user_id: number;
  role: string;
}

export const signAccessToken = (payload: TokenPayload) =>
  jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, {
    expiresIn: "15m",
  });

export const signRefreshToken = (payload: TokenPayload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET as string, {
    expiresIn: "7d",
  });

export const signResetToken = (payload: object) =>
  jwt.sign(payload, process.env.JWT_RESET_SECRET as string, {
    expiresIn: "15m",
  });
