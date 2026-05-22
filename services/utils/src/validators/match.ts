import { z } from "zod";

export const analyzeMatchSchema = z.object({
  resumeUrl: z.string().url("Invalid resume URL"),
  job: z.object({
    title: z.string().min(1, "Job title is required"),
    description: z.string().min(1, "Job description is required"),
    salary: z.union([z.number(), z.null()]).optional(),
    location: z.string().optional(),
    job_type: z.string().optional(),
    work_location: z.string().optional(),
    role: z.string().optional(),
    company_name: z.string().optional(),
  }),
});

export type AnalyzeMatchInput = z.infer<typeof analyzeMatchSchema>;
export type JobDetailsInput = AnalyzeMatchInput["job"];
