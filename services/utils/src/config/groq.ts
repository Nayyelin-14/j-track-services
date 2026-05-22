import Groq from "groq-sdk";

class GroqConfig {
  private static instance: Groq;
  private static readonly MODEL = "llama-3.3-70b-versatile";

  static getInstance(): Groq {
    if (!this.instance) {
      const apiKey = process.env.API_KEY_GROQ;
      if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
      this.instance = new Groq({ apiKey });
    }
    return this.instance;
  }

  static getModel(): string {
    return this.MODEL;
  }
}

export default GroqConfig;
