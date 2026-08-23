import { Request, Response } from "express";
import { listModels as discoverModels } from "../services/nim-models.js";

/**
 * GET /models — live NIM discovery (5-minute memory cache) for the frontend
 * selector. Returns { id, label, recommended } entries; serves the static
 * curated fallback list if NVIDIA discovery fails. Never triggers any
 * benchmarking.
 */
export const listModels = async (_req: Request, res: Response): Promise<void> => {
  try {
    const { models, source } = await discoverModels();
    res.json({ success: true, source, models });
  } catch (err) {
    console.error("[Models] Unexpected list failure:", (err as Error).message);
    res.status(502).json({ success: false, message: "Unable to load AI models" });
  }
};
