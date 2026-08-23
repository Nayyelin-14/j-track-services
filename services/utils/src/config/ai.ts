import OpenAI from "openai";

class AIConfig {
  private static instance: OpenAI;

  /**
   * NVIDIA hosts the API catalog (model listing + chat completions for catalog
   * models) on integrate.api.nvidia.com. The previously hardcoded
   * ai.api.nvidia.com host 404s on /v1/chat/completions for catalog model IDs,
   * which broke every NIM call. Override with NIM_BASE_URL if needed.
   */
  static getBaseUrl(): string {
    return process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
  }

  /**
   * Default execution model: first in the fallback chain. Curated from the
   * measured benchmark data — fastest of the top tier with perfect schema
   * compliance and clean good/poor-fit discrimination.
   */
  static getFallbackModel(): string {
    return process.env.NIM_DEFAULT_MODEL || "meta/llama-3.1-8b-instruct";
  }

  /** Default model for non-match AI features (career guidance, resume analysis). */
  static getModel(): string {
    return AIConfig.getFallbackModel();
  }

  static getInstance(): OpenAI {
    if (!this.instance) {
      const apiKey = process.env.API_KEY_NIM;
      if (!apiKey) {
        throw new Error(
          "API_KEY_NIM is not configured in environment variables",
        );
      }
      this.instance = new OpenAI({ apiKey, baseURL: AIConfig.getBaseUrl() });
    }
    return this.instance;
  }
}

export default AIConfig;
