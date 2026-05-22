import { GoogleGenAI } from "@google/genai";

class AIConfig {
  private static instance: GoogleGenAI;
  private static readonly MODEL = "gemini-2.0-flash-lite";

  static getInstance(): GoogleGenAI {
    if (!this.instance) {
      const apiKey = process.env.API_KEY_GEMINI;
      if (!apiKey) {
        throw new Error(
          "GEMINI_API_KEY is not configured in environment variables",
        );
      }
      this.instance = new GoogleGenAI({ apiKey });
    }
    return this.instance;
  }

  static getModel(): string {
    return this.MODEL;
  }
}

export default AIConfig;
