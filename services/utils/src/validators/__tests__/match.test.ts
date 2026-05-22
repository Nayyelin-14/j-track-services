import { describe, it, expect } from "vitest";
import { analyzeMatchSchema, type AnalyzeMatchInput } from "../match";

const validPayload: AnalyzeMatchInput = {
  resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
  job: {
    title: "Software Engineer",
    description: "We are looking for a senior software engineer...",
    salary: 150000,
    location: "San Francisco, CA",
    job_type: "full-time",
    work_location: "remote",
    role: "Senior Software Engineer",
    company_name: "Acme Corp",
  },
};

describe("analyzeMatchSchema", () => {
  it("accepts a valid full payload", () => {
    const result = analyzeMatchSchema.parse(validPayload);
    expect(result).toEqual(validPayload);
  });

  it("accepts payload with only required fields", () => {
    const minimal = {
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: {
        title: "Engineer",
        description: "Job description here",
      },
    };
    const result = analyzeMatchSchema.parse(minimal);
    expect(result.resumeUrl).toBe(minimal.resumeUrl);
    expect(result.job.title).toBe(minimal.job.title);
    expect(result.job.description).toBe(minimal.job.description);
    expect(result.job.salary).toBeUndefined();
    expect(result.job.location).toBeUndefined();
  });

  it("rejects missing resumeUrl", () => {
    const { resumeUrl: _, ...rest } = validPayload;
    expect(() => analyzeMatchSchema.parse(rest)).toThrow();
  });

  it("rejects invalid resumeUrl format", () => {
    const payload = { ...validPayload, resumeUrl: "not-a-url" };
    const result = analyzeMatchSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("resumeUrl"))).toBe(true);
    }
  });

  it("rejects empty job title", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, title: "" },
    };
    const result = analyzeMatchSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("title"))).toBe(true);
    }
  });

  it("rejects empty job description", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, description: "" },
    };
    const result = analyzeMatchSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("description"))).toBe(true);
    }
  });

  it("accepts null salary", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, salary: null },
    };
    const result = analyzeMatchSchema.parse(payload);
    expect(result.job.salary).toBeNull();
  });

  it("accepts numeric salary", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, salary: 120000 },
    };
    const result = analyzeMatchSchema.parse(payload);
    expect(result.job.salary).toBe(120000);
  });

  it("rejects string salary", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, salary: "high" },
    };
    const result = analyzeMatchSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("accepts all optional fields when present with valid values", () => {
    const result = analyzeMatchSchema.parse(validPayload);
    expect(result.job.location).toBe("San Francisco, CA");
    expect(result.job.job_type).toBe("full-time");
    expect(result.job.work_location).toBe("remote");
    expect(result.job.role).toBe("Senior Software Engineer");
    expect(result.job.company_name).toBe("Acme Corp");
  });

  it("rejects empty location string", () => {
    const payload = {
      ...validPayload,
      job: { ...validPayload.job, location: "" },
    };
    const result = analyzeMatchSchema.parse(payload);
    expect(result.job.location).toBe("");
  });

  it("preserves unknown fields in output", () => {
    const withExtra = {
      ...validPayload,
      extraField: "should be stripped by Zod but not cause error",
    };
    const result = analyzeMatchSchema.parse(withExtra);
    expect((result as Record<string, unknown>).extraField).toBeUndefined();
  });

  it("rejects payload with missing job object entirely", () => {
    const { job: _, ...noJob } = validPayload;
    expect(() => analyzeMatchSchema.parse(noJob)).toThrow();
  });
});
