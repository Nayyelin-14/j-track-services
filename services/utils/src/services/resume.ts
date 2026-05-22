import { Response } from "express";
import { fullResumePrompt, prepareResumeText } from "../config/prompts";
import GroqConfig from "../config/groq";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const writeSSE = (res: Response, data: object): void => {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

const callGroq = async (prompt: string): Promise<string> => {
  const ai = GroqConfig.getInstance();

  const response = await ai.chat.completions.create({
    model: GroqConfig.getModel(),
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1024,
    temperature: 0.1,
  });

  return response.choices[0]?.message?.content ?? "";
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
    console.log("PDF size:", buffer.length, "bytes");
    const start = Date.now();

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;

    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => item.str).join(" ");
      fullText += pageText + "\n";
    }

    console.log("PDF parsed in:", Date.now() - start, "ms");
    console.log("Resume text length:", fullText.length);

    if (!fullText || fullText.length < 50) {
      throw new Error("PDF is empty or unreadable.");
    }

    return prepareResumeText(fullText);
  }

  async streamResumeAnalysis(pdfBuffer: Buffer, res: Response): Promise<void> {
    writeSSE(res, { status: "extracting", message: "Reading your resume..." });

    const resumeText = await this.extractTextFromPDF(pdfBuffer);

    writeSSE(res, { status: "analyzing", message: "Analyzing..." });
    console.log("Resume text:\n", resumeText);
    const raw = await callGroq(fullResumePrompt(resumeText));
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
