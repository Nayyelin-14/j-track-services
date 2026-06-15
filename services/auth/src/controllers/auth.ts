import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import axios from "axios";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import {
  signAccessToken,
  signRefreshToken,
  signResetToken,
} from "@jtrack/shared/token";
import { accessCookieOptions, refreshCookieOptions } from "@jtrack/shared/cookies";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { getBuffer } from "@jtrack/shared/buffer";
import type { AuthRequest } from "@jtrack/shared/types";
import { kafka } from "../kafka.js";
import { createRedisHelpers } from "@jtrack/shared/redis/helpers";
import { redisClient } from "../redis.js";
import { resetPasswordEmailTemplate } from "../template.js";

const {
  checkForgotPasswordRate,
  clearFailedResetAttempts,
  clearForgotPasswordRate,
  deleteRedisValue,
  getRedisValue,
  setRedisValue,
  trackFailedResetAttempt,
} = createRedisHelpers(redisClient);

const UTIL_SERVICE = process.env.UTILS_SERVICE_URL || "http://localhost:6001/api/utils";

export const register = TryCatch(async (req: Request, res: Response) => {
  const { name, email, password, phone_number, role, bio } = req.body;

  if (!name || !email || !password || !phone_number || !role) {
    throw new ErrorHandler(400, "All fields are required");
  }

  const existingUser = await prisma.user.findFirst({
    where: { email },
    select: { email: true },
  });
  if (existingUser) {
    throw new ErrorHandler(400, "User already exists");
  }

  if (!["recruiter", "jobseeker"].includes(role)) {
    throw new ErrorHandler(400, "Invalid role");
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  if (role === "recruiter") {
    await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone_number,
        role: "recruiter",
      },
    });
  } else if (role === "jobseeker") {
    const file = req?.file;

    let url: string | null = null;
    let public_id: string | null = null;

    if (file) {
      const fileBuffer = getBuffer(file);
      if (fileBuffer && fileBuffer.content) {
        const response = await axios.post(`${UTIL_SERVICE}/upload`, {
          buffer: fileBuffer.content,
        });
        if (response.data?.success) {
          url = response.data.url;
          public_id = response.data.public_id;
        }
      }
    }

    await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone_number,
        role: "jobseeker",
        bio,
        resume: url,
        resume_public_id: public_id,
      },
    });
  }

  return res.status(201).json({
    message: "User registered successfully. Please login.",
  });
});

export const login = TryCatch(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ErrorHandler(400, "Credentials required");
  }

  const user = await prisma.user.findFirst({
    where: { email },
    select: { user_id: true, name: true, email: true, password: true, role: true },
  });

  if (!user) {
    throw new ErrorHandler(401, "Invalid credentials");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    throw new ErrorHandler(401, "Invalid credentials");
  }

  const payload = { user_id: user.user_id, role: user.role };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await prisma.user.update({
    where: { user_id: user.user_id },
    data: { refresh_token: refreshToken },
  });

  res.cookie("accessToken", accessToken, accessCookieOptions);
  res.cookie("refreshToken", refreshToken, refreshCookieOptions);

  return res.json({
    success: true,
    message: "Login success",
    user: {
      user_id: user.user_id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

export const logout = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;
  const refreshToken = req.cookies?.refreshToken;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const user = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: { user_id: true, refresh_token: true },
  });

  if (!user) {
    throw new ErrorHandler(404, "User not found");
  }

  if (refreshToken && user.refresh_token !== refreshToken) {
    throw new ErrorHandler(401, "Invalid session");
  }

  await prisma.user.update({
    where: { user_id: user.user_id },
    data: { refresh_token: null },
  });

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.json({
    success: true,
    message: "Logged out",
  });
});

const AUTH_USER_CACHE_PREFIX = "auth:user:";

async function invalidateUserAuthCache(user_id: number) {
  try {
    await redisClient.del(`${AUTH_USER_CACHE_PREFIX}${user_id}`);
  } catch (err) {
    console.warn("[Redis] Cache invalidation error (non-fatal):", err);
  }
}

export const getMe = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const cacheKey = `${AUTH_USER_CACHE_PREFIX}${userData.user_id}`;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const user = JSON.parse(cached);
      return res.json({ success: true, user, fromCache: true });
    }
  } catch (err) {
    console.warn("[Redis] Cache read error (non-fatal):", err);
  }

  const user = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: {
      user_id: true,
      name: true,
      email: true,
      role: true,
      phone_number: true,
      bio: true,
      resume: true,
      profile_pic: true,
      created_at: true,
    },
  });

  if (!user) {
    throw new ErrorHandler(404, "User not found");
  }

  try {
    await redisClient.setEx(cacheKey, 300, JSON.stringify(user));
  } catch (err) {
    console.warn("[Redis] Cache write error (non-fatal):", err);
  }

  return res.json({ success: true, user });
});

export const RESET_TOKEN_PREFIX = "reset:";

export const forgotPassword = TryCatch(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) throw new ErrorHandler(400, "Email is required");
  await checkForgotPasswordRate(email);

  const user = await prisma.user.findFirst({
    where: { email },
    select: { user_id: true, email: true, name: true },
  });

  if (!user) {
    return res.status(200).json({
      success: true,
      message: "If that email exists, a reset link has been sent",
    });
  }

  const resetToken = signResetToken({
    user_id: user.user_id,
    email: user.email,
    type: "reset-password",
  });

  await setRedisValue(
    `${RESET_TOKEN_PREFIX}${user.user_id}${user.email}`,
    resetToken,
    900,
  );

  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  try {
    await kafka.publish("send-mail", {
      type: "RESET_PASSWORD",
      to: user.email,
      subject: "Reset Your Password",
      html: resetPasswordEmailTemplate({
        name: user.name,
        resetLink,
        expiresInMinutes: 15,
      }),
    });
  } catch (error) {
    await deleteRedisValue(`${RESET_TOKEN_PREFIX}${user.user_id}${user.email}`);
    throw new ErrorHandler(
      500,
      "Failed to send reset email. Please try again.",
    );
  }

  return res.status(200).json({
    success: true,
    message: "If that email exists, a reset link has been sent",
  });
});

export const resetPassword = TryCatch(async (req: Request, res: Response) => {
  const token = req.params.token as string;
  const { newPassword } = req.body;

  if (!token || !newPassword) {
    throw new ErrorHandler(400, "Token and new password are required");
  }

  if (newPassword.length < 8) {
    throw new ErrorHandler(400, "Password must be at least 8 characters");
  }

  let payload: { user_id: number; email: string; type: string };
  try {
    payload = jwt.verify(token, process.env.JWT_RESET_SECRET!) as any;
  } catch {
    throw new ErrorHandler(400, "Invalid or expired reset link");
  }

  if (payload.type !== "reset-password") {
    throw new ErrorHandler(400, "Invalid token type");
  }

  await trackFailedResetAttempt(payload.user_id, payload.email, RESET_TOKEN_PREFIX);

  const storedToken = await getRedisValue(
    `${RESET_TOKEN_PREFIX}${payload.user_id}${payload.email}`,
  );

  if (!storedToken || storedToken !== token) {
    throw new ErrorHandler(400, "Reset link has already been used or expired");
  }

  const user = await prisma.user.findFirst({
    where: { user_id: payload.user_id, email: payload.email },
    select: { user_id: true },
  });

  if (!user) throw new ErrorHandler(404, "User no longer exists");

  await clearFailedResetAttempts(payload.user_id, payload.email);
  const hashedPassword = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { user_id: payload.user_id },
    data: { password: hashedPassword },
  });

  await deleteRedisValue(
    `${RESET_TOKEN_PREFIX}${payload.user_id}${payload.email}`,
  );
  await clearForgotPasswordRate(payload.email);

  return res.status(200).json({
    success: true,
    message: "Password reset successful. You can now log in.",
  });
});

export const changePassword = TryCatch(async (req: AuthRequest, res: Response) => {
  const user_id = req.user?.user_id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new ErrorHandler(
      400,
      "Current password and new password are required",
    );
  }

  if (newPassword.length < 8) {
    throw new ErrorHandler(400, "New password must be at least 8 characters");
  }

  if (currentPassword === newPassword) {
    throw new ErrorHandler(
      400,
      "New password must differ from current password",
    );
  }

  if (!user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const user = await prisma.user.findFirst({
    where: { user_id },
    select: { user_id: true, password: true },
  });
  if (!user) throw new ErrorHandler(404, "User not found");

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) throw new ErrorHandler(400, "Current password is incorrect");

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { user_id },
    data: { password: hashedPassword },
  });

  await prisma.user.update({
    where: { user_id },
    data: { refresh_token: null },
  });

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  await invalidateUserAuthCache(user_id);

  return res.status(200).json({
    success: true,
    message: "Password changed successfully. Please login again.",
  });
});
