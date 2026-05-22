import { z } from "zod";

export const MAX_PDF_SIZE_MB = 5;
export const MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024;

export const resumeFileSchema = z.object({
  mimetype: z.literal("application/pdf", {
    message: "Only PDF files are allowed",
  }),
  size: z
    .number()
    .min(1, "File is empty")
    .max(MAX_PDF_SIZE_BYTES, `File size must not exceed ${MAX_PDF_SIZE_MB}MB`),
  originalname: z.string().regex(/\.pdf$/i, "File must have a .pdf extension"),
});

export type ResumeFileInput = z.infer<typeof resumeFileSchema>;

export const validateResumeFile = (
  file: Express.Multer.File,
): ResumeFileInput => {
  return resumeFileSchema.parse({
    mimetype: file.mimetype,
    size: file.size,
    originalname: file.originalname,
  });
};
