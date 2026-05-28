import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import axios from "axios";
import { sql } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import {
  signAccessToken,
  signRefreshToken,
  signResetToken,
} from "@jtrack/shared/token";
import { accessCookieOptions, refreshCookieOptions } from "@jtrack/shared/cookies";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { getBuffer } from "@jtrack/shared/buffer";
import { kafka } from "../kafka.js";
import { createRedisHelpers, withCache } from "@jtrack/shared/redis/helpers";
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

  const [existingUser] = await sql`
    SELECT email
    FROM users
    WHERE email = ${email}
    LIMIT 1
  `;
  if (existingUser) {
    throw new ErrorHandler(400, "User already exists");
  }

  if (!["recruiter", "jobseeker"].includes(role)) {
    throw new ErrorHandler(400, "Invalid role");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  let registerUser;
  if (role === "recruiter") {
    const [user] = await sql`
    INSERT INTO users (name, email, password, phone_number, role)
    VALUES (${name}, ${email}, ${hashedPassword}, ${phone_number}, ${role}) RETURNING user_id , name , email , phone_number , role , created_at
  `;
    registerUser = user;
  } else if (role === "jobseeker") {
    const file = req?.file;

    if (!file) {
      throw new ErrorHandler(500, "Failed to generate buffer");
    }

    const fileBuffer = getBuffer(file);

    if (!fileBuffer || !fileBuffer.content) {
      throw new ErrorHandler(400, "Resume file is required for job seekers");
    }

    const response = await axios.post(`${UTIL_SERVICE}/upload`, {
      buffer: fileBuffer.content,
    });
    if (!response.data?.success) {
      throw new ErrorHandler(500, "Upload failed");
    }

    const { url, public_id } = response.data;

    if (!url || !public_id) {
      throw new ErrorHandler(500, "Invalid upload response");
    }
    const [user] = await sql`
    INSERT INTO users (name, email, password, phone_number, role , bio , resume ,resume_public_id  )
    VALUES (${name}, ${email}, ${hashedPassword}, ${phone_number}, ${role} ,${bio} , ${url} ,${public_id} )
    RETURNING user_id , name , email , phone_number , role ,bio ,resume , resume_public_id created_at
  `;
    registerUser = user;
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

  const [user] = await sql`
    SELECT user_id, name, email, password, role
    FROM users
    WHERE email = ${email}
    LIMIT 1
  `;

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

  await sql`
    UPDATE users
    SET refresh_token = ${refreshToken}
    WHERE user_id = ${user.user_id}
  `;

  res.cookie("accessToken", accessToken, accessCookieOptions);
  res.cookie("refreshToken", refreshToken, refreshCookieOptions);

  return res.json({
    message: "Login success",
    user: {
      user_id: user.user_id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

export const logout = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;
  const refreshToken = req.cookies?.refreshToken;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const [user] = await sql`
    SELECT user_id, refresh_token
    FROM users
    WHERE user_id = ${userData.user_id}
    LIMIT 1
  `;

  if (!user) {
    throw new ErrorHandler(404, "User not found");
  }

  if (refreshToken && user.refresh_token !== refreshToken) {
    throw new ErrorHandler(401, "Invalid session");
  }

  await sql`
    UPDATE users
    SET refresh_token = NULL
    WHERE user_id = ${user.user_id}
  `;

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.json({
    success: true,
    message: "Logged out",
  });
});

export const getMe = TryCatch(async (req: Request, res: Response) => {
  const userData = (req as any).user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  const { data: user, fromCache } = await withCache(
    redisClient,
    `auth:user:${userData.user_id}`,
    300,
    async () => {
      const [user] = await sql`
        SELECT
          user_id,
          name,
          email,
          role,
          phone_number,
          bio,
          resume,
          profile_pic,
          created_at
        FROM users
        WHERE user_id = ${userData.user_id}
        LIMIT 1
      `;

      if (!user) {
        throw new ErrorHandler(404, "User not found");
      }

      return user;
    },
  );

  return res.json({ success: true, user, ...(fromCache && { fromCache }) });
});

export const RESET_TOKEN_PREFIX = "reset:";

export const forgotPassword = TryCatch(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) throw new ErrorHandler(400, "Email is required");
  await checkForgotPasswordRate(email);

  const [user] = await sql`
    SELECT user_id, email, name
    FROM users
    WHERE email = ${email}
    LIMIT 1
  `;

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
    throw new ErrorHandler(400, "Something went wrong");
  }

  await trackFailedResetAttempt(payload.user_id, payload.email, RESET_TOKEN_PREFIX);

  const storedToken = await getRedisValue(
    `${RESET_TOKEN_PREFIX}${payload.user_id}${payload.email}`,
  );

  if (!storedToken || storedToken !== token) {
    throw new ErrorHandler(400, "Reset link has already been used or expired");
  }

  const [user] = await sql`
    SELECT user_id FROM users
    WHERE user_id = ${payload.user_id} AND email = ${payload.email}
    LIMIT 1
  `;

  if (!user) throw new ErrorHandler(404, "User no longer exists");

  await clearFailedResetAttempts(payload.user_id, payload.email);
  const hashedPassword = await bcrypt.hash(newPassword, 12);

  await sql`
    UPDATE users
    SET password = ${hashedPassword}
    WHERE user_id = ${payload.user_id}
  `;

  await deleteRedisValue(
    `${RESET_TOKEN_PREFIX}${payload.user_id}${payload.email}`,
  );
  await clearForgotPasswordRate(payload.email);

  return res.status(200).json({
    success: true,
    message: "Password reset successful. You can now log in.",
  });
});

export const changePassword = TryCatch(async (req: Request, res: Response) => {
  const user_id = (req as any).user?.user_id;
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

  const [user] = await sql`
    SELECT user_id, password
    FROM users
    WHERE user_id = ${user_id}
    LIMIT 1
  `;
  if (!user) throw new ErrorHandler(404, "User not found");

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) throw new ErrorHandler(401, "Current password is incorrect");

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  await sql`
    UPDATE users
    SET password = ${hashedPassword}
    WHERE user_id = ${user_id}
  `;

  await sql`
    UPDATE users
    SET refresh_token = NULL
    WHERE user_id = ${user_id}
  `;

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.status(200).json({
    success: true,
    message: "Password changed successfully. Please login again.",
  });
});
