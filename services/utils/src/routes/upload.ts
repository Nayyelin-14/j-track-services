import { Router, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

const router = Router();

const MAX_BASE64_SIZE = 10 * 1024 * 1024;
const PUBLIC_ID_REGEX = /^[\w\-\/]+$/;

router.post(
  "/upload",
  TryCatch(async (req: Request, res: Response) => {
    const { public_id, buffer } = req.body;

    if (!buffer || typeof buffer !== "string") {
      throw new ErrorHandler(400, "Buffer (base64 data URI) is required");
    }
    if (buffer.length > MAX_BASE64_SIZE) {
      throw new ErrorHandler(400, "File too large — max 10 MB");
    }

    if (public_id) {
      if (typeof public_id !== "string" || !PUBLIC_ID_REGEX.test(public_id)) {
        throw new ErrorHandler(400, "Invalid public_id format");
      }
      const destroyed = await cloudinary.uploader.destroy(public_id);
      if (destroyed.result !== "ok" && destroyed.result !== "not found") {
        throw new ErrorHandler(500, "Failed to delete old image");
      }
    }

    const result = await cloudinary.uploader.upload(buffer, {
      folder: "j-track",
      resource_type: "auto",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      transformation: [{ width: 800, height: 800, crop: "limit" }],
    });

    if (!result?.secure_url || !result?.public_id) {
      throw new ErrorHandler(500, "Upload failed — no URL returned");
    }

    return res.status(200).json({
      success: true,
      message: "Upload successful",
      url: result.secure_url,
      public_id: result.public_id,
    });
  }),
);

router.delete(
  "/:public_id",
  TryCatch(async (req: Request, res: Response) => {
    const public_id = req.params.public_id as string;

    if (!public_id || !PUBLIC_ID_REGEX.test(public_id)) {
      throw new ErrorHandler(400, "Invalid public_id format");
    }

    const destroyed = await cloudinary.uploader.destroy(public_id);
    if (destroyed.result !== "ok" && destroyed.result !== "not found") {
      throw new ErrorHandler(500, "Failed to delete image");
    }

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
    });
  }),
);

export default router;
