import { Response } from "express";
import AIConfig from "../config/ai.js";
import { prepareResumeText } from "../config/prompts.js";
import { buildModelChain, extractJson, validateRequestedModel } from "./nim-models.js";
import { runNimStream, type NimMessage, type StreamOutcome } from "./nim-stream.js";
import { PDFParse } from "pdf-parse";

const writeSSE = (res: Response, data: object): void => {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

export interface JobDetails {
  title: string;
  description: string;
  salary: number | string | null | undefined;
  location: string | undefined;
  job_type: string | undefined;
  work_location: string | undefined;
  role: string | undefined;
  company_name: string | undefined;
  details?: {
    responsibilities?: string;
    required_skills?: string;
    preferred_skills?: string;
    tech_stack?: string[];
    experience_years?: number;
    education?: string;
    certifications?: string[];
    languages?: string[];
    benefits?: string;
    visa_sponsorship?: boolean;
    working_hours?: string;
    team_structure?: string;
    reporting_line?: string;
    career_growth?: string;
    interview_process?: string;
    application_instructions?: string;
    [key: string]: unknown;
  } | null;
}

/** Recruiter instructions live in a proper system message so models that
 * reject the system role can be detected and worked around (see below). */
const MATCH_SYSTEM_PROMPT = [
  "You are an expert technical recruiter with 15+ years of experience.",
  "Analyze how well the given resume matches the job posting.",
  "Respond with ONLY valid JSON, no markdown, no code blocks, no extra text:",
  "{",
  '  "matchScore": number,',
  '  "strengths": string[],',
  '  "gaps": string[],',
  '  "recommendation": "yes" | "maybe" | "no",',
  '  "recommendationReason": string,',
  '  "summary": string,',
  '  "fullAnalysis": string',
  "}",
].join("\n");

const matchUserPrompt = (resumeText: string, job: JobDetails): string => {
  const parts: string[] = [
    "RESUME TEXT:",
    `"""`,
    resumeText,
    `"""`,
    "",
    "JOB POSTING:",
    `Title: ${job.title}`,
    `Description: ${job.description}`,
  ];

  if (job.salary != null) parts.push(`Salary: ${job.salary}`);
  if (job.location) parts.push(`Location: ${job.location}`);
  if (job.job_type) parts.push(`Type: ${job.job_type}`);
  if (job.work_location) parts.push(`Work Location: ${job.work_location}`);
  if (job.role) parts.push(`Role: ${job.role}`);
  if (job.company_name) parts.push(`Company: ${job.company_name}`);

  if (job.details) {
    const d = job.details;
    if (d.responsibilities) parts.push(`Responsibilities: ${d.responsibilities}`);
    if (d.required_skills) parts.push(`Required Skills: ${d.required_skills}`);
    if (d.preferred_skills) parts.push(`Preferred Skills: ${d.preferred_skills}`);
    if (d.tech_stack?.length) parts.push(`Tech Stack: ${d.tech_stack.join(", ")}`);
    if (d.experience_years) parts.push(`Experience Required: ${d.experience_years} years`);
    if (d.education) parts.push(`Education: ${d.education}`);
    if (d.certifications?.length) parts.push(`Certifications: ${d.certifications.join(", ")}`);
    if (d.languages?.length) parts.push(`Languages: ${d.languages.join(", ")}`);
    if (d.benefits) parts.push(`Benefits: ${d.benefits}`);
    if (d.visa_sponsorship != null) parts.push(`Visa Sponsorship: ${d.visa_sponsorship ? "Yes" : "No"}`);
    if (d.working_hours) parts.push(`Working Hours: ${d.working_hours}`);
    if (d.team_structure) parts.push(`Team Structure: ${d.team_structure}`);
    if (d.reporting_line) parts.push(`Reports To: ${d.reporting_line}`);
    if (d.career_growth) parts.push(`Career Growth: ${d.career_growth}`);
    if (d.interview_process) parts.push(`Interview Process: ${d.interview_process}`);
  }

  parts.push(
    "",
    "Analyze the match and provide:",
    "1. Match Score (0-100) based on skills, experience, and qualifications",
    "2. Key Strengths - specific areas where the candidate's resume aligns with job requirements",
    "3. Gaps - skills or experience required by the job but missing from the resume",
    "4. Overall Recommendation - 'yes', 'maybe', or 'no'",
    "5. A brief summary of the analysis",
    "6. Full analysis in natural language",
    "",
    "Return ONLY the JSON. No markdown, no code blocks, no extra text.",
  );

  return parts.join("\n");
};

class MatchService {
  async downloadAndParseResume(
    url: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/pdf,application/octet-stream,*/*" },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download resume: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());

    if (
      contentType.includes("pdf") ||
      buffer.toString("ascii", 0, 5).includes("%PDF")
    ) {
      const { text: fullText } = await new PDFParse({ data: buffer }).getText();

      if (!fullText || fullText.length < 10) {
        throw new Error("Resume PDF is empty or unreadable");
      }

      return prepareResumeText(fullText);
    }

    throw new Error(`Unsupported resume format: ${contentType || "unknown"}`);
  }

  async streamMatchAnalysis(
    resumeUrl: string,
    job: JobDetails,
    res: Response,
    signal: AbortSignal,
    requestedModel?: string,
  ): Promise<void> {
    writeSSE(res, {
      status: "progress",
      stage: "download",
      message: "Downloading resume from Cloudinary",
    });

    const resumeText = await this.downloadAndParseResume(resumeUrl, signal);

    // Validate the override against the discovered catalog before executing.
    const validation = await validateRequestedModel(requestedModel);
    let firstChoice = requestedModel;
    if (!validation.valid) {
      firstChoice = undefined;
      writeSSE(res, {
        status: "model_fallback",
        requested_model: requestedModel,
        used_model: AIConfig.getFallbackModel(),
        reason: "invalid_model",
        message: `The selected model is not available. Using ${AIConfig.getFallbackModel()} instead.`,
      });
    }

    // Execution chain: requested → default → remaining recommended, deduped.
    const chain = buildModelChain(firstChoice);

    writeSSE(res, {
      status: "progress",
      stage: "analyze",
      message: `Analyzing match with NVIDIA NIM (${chain[0]})`,
    });

    const messages: NimMessage[] = [
      { role: "system", content: MATCH_SYSTEM_PROMPT },
      { role: "user", content: matchUserPrompt(resumeText, job) },
    ];

    // Walk the chain. Once ANY output has streamed to the client we must not
    // switch models — retrying would duplicate or contradict shown content.
    let anyOutputEmitted = false;
    const onText = (text: string): void => {
      anyOutputEmitted = true;
      writeSSE(res, { status: "chunk", text });
    };

    let outcome: StreamOutcome | null = null;
    let usedModel = chain[0]!;
    let lastError: unknown = null;

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i]!;
      usedModel = candidate;
      try {
        outcome = await runNimStream(candidate, messages, signal, onText);
        break;
      } catch (err) {
        lastError = err;
        if (signal.aborted) return;
        if (anyOutputEmitted) throw err; // never switch mid-stream
        const isLast = i === chain.length - 1;
        if (!isLast) {
          const next = chain[i + 1]!;
          writeSSE(res, {
            status: "model_fallback",
            requested_model: candidate,
            used_model: next,
            reason: "runtime_failure",
            message: `${candidate} failed during analysis. Retrying with ${next}.`,
          });
        }
      }
    }

    if (!outcome) {
      throw lastError instanceof Error
        ? lastError
        : new Error("All models in the fallback chain failed");
    }

    const parsed = this.parseAIResponse(outcome.text);

    writeSSE(res, {
      status: "complete",
      model_used: usedModel,
      usage: outcome.usage,
      latency_ms: outcome.latencyMs,
      result: {
        matchScore:
          typeof parsed.matchScore === "number" ? parsed.matchScore : 0,
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        recommendation: ["yes", "maybe", "no"].includes(
          parsed.recommendation as string,
        )
          ? (parsed.recommendation as string)
          : "maybe",
        recommendationReason: parsed.recommendationReason || "",
        summary: parsed.summary || "",
        fullAnalysis: parsed.fullAnalysis || outcome.text,
      },
    });
  }

  parseAIResponse(rawText: string): Record<string, unknown> {
    const direct = extractJson(rawText);
    if (direct && typeof direct === "object") {
      return direct as Record<string, unknown>;
    }
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return {
        matchScore: 0,
        strengths: [],
        gaps: [],
        recommendation: "maybe",
        recommendationReason: "Could not parse AI response as JSON",
        summary: "",
        fullAnalysis: cleaned,
      };
    }
  }
}

export default new MatchService();
