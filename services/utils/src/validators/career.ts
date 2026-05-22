import { z } from "zod";

export const careerGuidanceSchema = z.object({
  skills: z
    .array(z.string().min(1).max(100))
    .min(1, "At least one skill is required")
    .max(20, "Maximum 20 skills allowed"),

  experienceLevel: z
    .enum(["junior", "mid", "senior"])
    .optional()
    .default("mid"),

  targetRole: z.string().min(2).max(200).optional(),
});

export type CareerGuidanceInput = z.infer<typeof careerGuidanceSchema>;

export const validateCareerGuidance = (body: unknown): CareerGuidanceInput => {
  return careerGuidanceSchema.parse(body);
};
