import { Response } from "express";
import { careerGuidancePrompt } from "../config/prompts";
import { CareerGuidanceInput } from "../validators/career";
import AIConfig from "../config/ai";

const writeSSE = (res: Response, data: object): void => {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

class CareerService {
  async streamCareerGuidance(
    input: CareerGuidanceInput,
    res: Response,
    signal: AbortSignal,
  ): Promise<void> {
    const ai = AIConfig.getInstance();
    const startTime = Date.now();
    let fullText = "";

    writeSSE(res, { status: "start" });

    const stream = await ai.models.generateContentStream({
      model: AIConfig.getModel(),
      contents: careerGuidancePrompt(input.skills.join(", ")),
      config: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    });

    for await (const chunk of stream) {
      if (signal.aborted) {
        console.info("Client disconnected, aborting stream");
        return;
      }

      const chunkText = chunk.text ?? "";
      fullText += chunkText;
      writeSSE(res, { chunk: chunkText });
    }

    const parsed = this.parseAIResponse(fullText);
    const responseTime = Date.now() - startTime;

    writeSSE(res, {
      status: "done",
      result: parsed,
      meta: {
        responseTime,
        model: AIConfig.getModel(),
      },
    });
  }

  private parseAIResponse(rawText: string): object {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(
        "AI returned non-JSON response. Raw: " + cleaned.slice(0, 200),
      );
    }
  }
}

export default new CareerService();
