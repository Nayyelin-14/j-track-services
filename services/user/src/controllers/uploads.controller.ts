import { Request, Response } from "express";
import axios from "axios";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import { getBuffer } from "@jtrack/shared/buffer";
import type { AuthRequest } from "@jtrack/shared/types";
import { UTIL_SERVICE, invalidateUserCache } from "./utils.js";

export const uploadProfilePic = TryCatch(
  async (req: AuthRequest, res: Response) => {
    const userData = req.user;

    if (!userData?.user_id) {
      throw new ErrorHandler(401, "Unauthorized");
    }

    const file = req.file;
    if (!file) {
      throw new ErrorHandler(400, "Image file is required");
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new ErrorHandler(400, "Only image files are allowed");
    }

    const fileBuffer = getBuffer(file);
    if (!fileBuffer?.content) {
      throw new ErrorHandler(500, "Failed to process image");
    }

    const currentUser = await prisma.user.findFirst({
      where: { user_id: userData.user_id },
      select: { profile_pic_public_id: true },
    });
    if (!currentUser) throw new ErrorHandler(404, "User not found");

    const uploadPayload: Record<string, string> = {
      buffer: fileBuffer.content,
    };
    if (currentUser.profile_pic_public_id) {
      uploadPayload.public_id = currentUser.profile_pic_public_id;
    }

    let uploadRes;
    try {
      uploadRes = await axios.post(`${UTIL_SERVICE}/upload`, uploadPayload, {
        timeout: 30_000,
      });
    } catch {
      throw new ErrorHandler(502, "Upload service unavailable");
    }

    if (!uploadRes.data?.success) {
      throw new ErrorHandler(500, "Upload failed");
    }

    const { url, public_id } = uploadRes.data;
    if (!url || !public_id) {
      throw new ErrorHandler(500, "Invalid response from upload service");
    }

    const updated = await prisma.user.update({
      where: { user_id: userData.user_id },
      data: { profile_pic: url, profile_pic_public_id: public_id },
      select: { user_id: true, profile_pic: true },
    });

    await invalidateUserCache(userData.user_id);

    return res.json({
      success: true,
      message: "Profile picture updated",
      profile_pic: updated?.profile_pic,
    });
  },
);

export const uploadResume = TryCatch(async (req: AuthRequest, res: Response) => {
  const userData = req.user;

  if (!userData?.user_id) {
    throw new ErrorHandler(401, "Unauthorized");
  }

  if (userData.role !== "jobseeker") {
    throw new ErrorHandler(403, "Only job seekers can upload a resume");
  }

  const file = req.file;
  if (!file) {
    throw new ErrorHandler(400, "Resume file is required");
  }

  const allowedMimes = ["application/pdf"];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ErrorHandler(400, "Only PDF files are allowed for resumes");
  }

  const fileBuffer = getBuffer(file);
  if (!fileBuffer?.content) {
    throw new ErrorHandler(500, "Failed to process resume file");
  }

  const currentUser = await prisma.user.findFirst({
    where: { user_id: userData.user_id },
    select: { resume_public_id: true },
  });
  if (!currentUser) throw new ErrorHandler(404, "User not found");

  const uploadPayload: Record<string, string> = {
    buffer: fileBuffer.content,
  };
  if (currentUser.resume_public_id) {
    uploadPayload.public_id = currentUser.resume_public_id;
  }

  let uploadRes;
  try {
    uploadRes = await axios.post(`${UTIL_SERVICE}/upload`, uploadPayload, {
      timeout: 30_000,
    });
  } catch {
    throw new ErrorHandler(502, "Upload service unavailable");
  }

  if (!uploadRes.data?.success) {
    throw new ErrorHandler(500, "Resume upload failed");
  }

  const { url, public_id } = uploadRes.data;
  if (!url || !public_id) {
    throw new ErrorHandler(500, "Invalid response from upload service");
  }

  const updated = await prisma.user.update({
    where: { user_id: userData.user_id },
    data: { resume: url, resume_public_id: public_id },
    select: { user_id: true, resume: true },
  });

  await invalidateUserCache(userData.user_id);

  return res.json({
    success: true,
    message: "Resume updated",
    resume: updated?.resume,
  });
});
