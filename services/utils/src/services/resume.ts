import { Response } from "express";
import { fullResumePrompt, prepareResumeText } from "../config/prompts.js";
import AIConfig from "../config/ai.js";
import { PDFParse } from "pdf-parse";

/** Stable machine-readable failure codes emitted to SSE clients. */
export type ResumeErrorCode =
  | "EMPTY_FILE"
  | "INVALID_PDF"
  | "PARSE_TIMEOUT"
  | "EMPTY_TEXT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "ABORTED";

const EXTRACT_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 3_000;
const NIM_TIMEOUT_MS = 60_000;

export class ResumeError extends Error {
  code: ResumeErrorCode;

  constructor(code: ResumeErrorCode, message: string) {
    super(message);
    this.name = "ResumeError";
    this.code = code;
  }
}

const writeSSE = (res: Response, data: object): void => {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

/** Race a promise against a deadline without leaking timers. */
const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  code: ResumeErrorCode,
  message: string,
): Promise<T> => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ResumeError(code, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
};

const callNim = async (
  prompt: string,
  signal?: AbortSignal,
): Promise<string> => {
  const ai = AIConfig.getInstance();

  try {
    const response = await withTimeout(
      ai.chat.completions.create({
        model: AIConfig.getModel(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
        temperature: 0.1,
      }, { signal }),
      NIM_TIMEOUT_MS,
      "UPSTREAM_TIMEOUT",
      "Analysis timed out",
    );
    return response.choices[0]?.message?.content ?? "";
  } catch (err) {
    if (err instanceof ResumeError) throw err;
    throw new ResumeError("UPSTREAM_ERROR", "Analysis failed upstream");
  }
};

const parseChunk = (raw: string): object => {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse AI response: ${cleaned.slice(0, 100)}`);
  }
};

class ResumeService {
  async extractTextFromPDF(buffer: Buffer): Promise<string> {
    if (buffer.length === 0) {
      throw new ResumeError("EMPTY_FILE", "Uploaded file is empty");
    }

    const start = Date.now();
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    let fullText: string;
    try {
      const data = await withTimeout(
        parser.getText(),
        EXTRACT_TIMEOUT_MS,
        "PARSE_TIMEOUT",
        "Resume parsing timed out",
      );
      fullText = data.text;
    } catch (err) {
      // Normalise parser failures to a stable client-facing code.
      if (err instanceof ResumeError) throw err;
      throw new ResumeError("INVALID_PDF", "Could not read the uploaded PDF");
    } finally {
      // Cleanup must never hang or mask the original error.
      try {
        await withTimeout(
          Promise.resolve(parser.destroy()),
          DESTROY_TIMEOUT_MS,
          "PARSE_TIMEOUT",
          "parser cleanup timed out",
        );
      } catch (destroyErr) {
        console.error("[Resume] Parser cleanup failed:", destroyErr);
      }
    }

    console.log("PDF parsed in:", Date.now() - start, "ms");

    if (!fullText || fullText.length < 50) {
      throw new ResumeError(
        "EMPTY_TEXT",
        "PDF is empty or unreadable.",
      );
    }

    return prepareResumeText(fullText);
  }

  async streamResumeAnalysis(
    pdfBuffer: Buffer,
    res: Response,
    signal?: AbortSignal,
  ): Promise<void> {
    writeSSE(res, { status: "extracting", message: "Reading your resume..." });

    const resumeText = await this.extractTextFromPDF(pdfBuffer);

    if (signal?.aborted) {
      throw new ResumeError("ABORTED", "Client disconnected");
    }

    writeSSE(res, { status: "analyzing", message: "Analyzing..." });
    const raw = await callNim(fullResumePrompt(resumeText), signal);
    const result = parseChunk(raw) as any;

    writeSSE(res, {
      status: "done",
      result: {
        atsScore: result.atsScore ?? {},
        candidateProfile: result.candidateProfile ?? {},
        summary: result.summary ?? "",
        detectedSkills: result.detectedSkills ?? {},
        missingKeywords: result.missingKeywords ?? [],
        suggestedRoles: result.suggestedRoles ?? [],
        strengths: result.strengths ?? [],
        improvements: result.improvements ?? [],
        quickWins: result.quickWins ?? [],
      },
    });

    res.end();
  }
}

export default new ResumeService();
