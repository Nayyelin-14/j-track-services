import { z } from "zod";

const jobDetailsSchema = z.object({
  responsibilities: z.string().optional(),
  required_skills: z.string().optional(),
  preferred_skills: z.string().optional(),
  tech_stack: z.array(z.string()).optional(),
  experience_years: z.number().int().positive().optional(),
  education: z.string().optional(),
  certifications: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  benefits: z.string().optional(),
  visa_sponsorship: z.boolean().optional(),
  working_hours: z.string().optional(),
  team_structure: z.string().optional(),
  reporting_line: z.string().optional(),
  career_growth: z.string().optional(),
  interview_process: z.string().optional(),
  application_instructions: z.string().optional(),
}).optional();

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
    details: jobDetailsSchema,
  }),
});

export type AnalyzeMatchInput = z.infer<typeof analyzeMatchSchema>;
export type JobDetailsInput = AnalyzeMatchInput["job"];
