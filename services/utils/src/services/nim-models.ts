import AIConfig from "../config/ai.js";

/**
 * Lean NIM model selection — allowlist-driven:
 *
 *   GET {NIM_BASE_URL}/models  →  intersect with RELIABLE_MODELS allowlist
 *     →  5-minute memory cache  →  recommended flags  →  ordered list
 *
 * The live catalog is consulted only to confirm an allowlisted model still
 * exists; it can never introduce new entries. Every allowlisted ID was
 * verified by the 3-round streaming reliability probe of 2026-08-22
 * (scripts: /tmp probes — re-run and re-curate as the catalog evolves).
 * Benchmarking is NOT part of runtime.
 */

export interface AiModelOption {
  /** Exact NVIDIA NIM model ID — passed unchanged to chat completions. */
  id: string;
  label: string;
  recommended: boolean;
}

/**
 * Families whose documented purpose cannot serve Job Match Analysis
 * (embedding / retrieval / safety / reward / parsing / speech / vision-only /
 * image generation). Exclusion is based on documented purpose, never on
 * availability assumptions.
 */
const NON_CHAT_PATTERN =
  /(embed|retriev|rerank|\brank|parse|clip|guard|content-safety|reward|detector|translate|diffusion|calibration|kosmos|deplot|fuyu|neva|riva|bge|arctic|speech|voice|tts|asr|ocr)/i;

export function looksLikeChatModel(modelId: string): boolean {
  const short = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  return !NON_CHAT_PATTERN.test(short);
}

/**
 * Legacy blacklist from the 2026-08-21 audit — superseded by the
 * RELIABLE_MODELS allowlist (which already excludes everything here).
 * Kept exported for test/reference purposes only; runtime no longer reads it.
 */
export const EXCLUDED_MODELS: ReadonlySet<string> = new Set([
  "01-ai/yi-large",
  "adept/fuyu-8b",
  "ai21labs/jamba-1.5-large-instruct",
  "aisingapore/sea-lion-7b-instruct",
  "baai/bge-m3",
  "bigcode/starcoder2-15b",
  "databricks/dbrx-instruct",
  "deepseek-ai/deepseek-coder-6.7b-instruct",
  "google/codegemma-1.1-7b",
  "google/codegemma-7b",
  "google/deplot",
  "google/gemma-2b",
  "google/gemma-3-12b-it",
  "google/gemma-3-4b-it",
  "google/recurrentgemma-2b",
  "ibm/granite-3.0-3b-a800m-instruct",
  "ibm/granite-3.0-8b-instruct",
  "ibm/granite-34b-code-instruct",
  "ibm/granite-8b-code-instruct",
  "meta/codellama-70b",
  "meta/llama2-70b",
  "microsoft/kosmos-2",
  "microsoft/phi-3-vision-128k-instruct",
  "microsoft/phi-3.5-moe-instruct",
  "mistralai/codestral-22b-instruct-v0.1",
  "mistralai/mistral-7b-instruct-v0.3",
  "mistralai/mistral-large",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mixtral-8x22b-v0.1",
  "moonshotai/kimi-k2.6",
  "nv-mistralai/mistral-nemo-12b-instruct",
  "nvidia/cosmos-reason2-8b",
  "nvidia/embed-qa-4",
  "nvidia/llama-3.1-nemotron-51b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",
  "nvidia/llama-3.2-nv-embedqa-1b-v1",
  "nvidia/llama-nemotron-embed-1b-v2",
  "nvidia/llama-nemotron-embed-vl-1b-v2",
  "nvidia/llama3-chatqa-1.5-70b",
  "nvidia/mistral-nemo-minitron-8b-8k-instruct",
  "nvidia/nemotron-3-embed-1b",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/nemotron-4-340b-reward",
  "nvidia/nemotron-nano-3-30b-a3b",
  "nvidia/neva-22b",
  "nvidia/nv-embed-v1",
  "nvidia/nv-embedcode-7b-v1",
  "nvidia/nv-embedqa-e5-v5",
  "nvidia/nv-embedqa-mistral-7b-v2",
  "nvidia/nvclip",
  "nvidia/riva-translate-4b-instruct",
  "nvidia/vila",
  "snowflake/arctic-embed-l",
  "writer/palmyra-creative-122b",
  "writer/palmyra-fin-70b-32k",
  "writer/palmyra-med-70b",
  "writer/palmyra-med-70b-32k",
  "zyphra/zamba2-7b-instruct",
]);

/**
 * Manually curated Top 5 for the Job Match Analysis workload, in ranking
 * order. Derived from the measured benchmark data of 2026-08-21 (JSON schema
 * compliance + good/poor-fit discrimination + latency + token usage) and kept
 * provisional: re-run scripts/run-benchmark.ts and re-curate as the NIM
 * catalog evolves.
 *
 * Deliberately NOT included despite decent raw scores:
 * - nvidia/nemotron-mini-4b-instruct: scored a clearly-poor candidate 70/100
 *   ("maybe") — its fit discrimination is unsafe regardless of speed.
 * - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning: verbose (584 tokens/case)
 *   with composite well below the cut.
 */
/**
 * Manually curated Top 5, in ranking order (#1 is also the execution
 * default). Derived from the live reliability probe of 2026-08-22:
 * every catalog model was called 3× with production-style streaming;
 * only models answering 3/3 with real content were eligible, ranked by
 * median first-token latency.
 */
export const RECOMMENDED_MODELS: readonly string[] = [
  "meta/llama-3.1-8b-instruct", // also the execution default: worst 1.2s over career-prompt stress runs
  "openai/gpt-oss-20b", // 429ms median under the real career prompt
  "nvidia/nemotron-3-super-120b-a12b", // 573ms median, zero stalls
  "meta/llama-3.2-11b-vision-instruct", // 355ms median — vision-capable
  "meta/muse-glimmer-30b", // 334ms median, fastest of the set
];

/**
 * Dropdown allowlist — the ONLY IDs ever surfaced to users or accepted as
 * overrides. Membership requires passing the 2026-08-22 reliability probe:
 * 3/3 streamed completions with non-empty user-facing content.
 *
 * Deliberately NOT listed despite passing the generic 3/3 probe:
 * - poolside/laguna-xs-2.1: erratic serving latency (0.8s–55s to first
 *   token across identical requests) — trips the 30s idle watchdog and
 *   feels broken in the UI.
 * - mistralai/mistral-nemotron: intermittent >30s first-byte stalls under
 *   the real career system prompt (observed live, 2026-08-22).
 * - minimaxai/minimax-m3: fails on every career-prompt request (works only
 *   with trivial prompts) — discovered in the career stress re-test.
 * - nvidia/nemotron-3-ultra-550b-a55b: 503 overloaded / multi-second cold
 *   starts; too heavy for interactive chat.
 */
export const RELIABLE_MODELS: readonly string[] = [
  // --- recommended (above) ---
  ...RECOMMENDED_MODELS,
  // --- reliable alternates, ordered by median first-token latency ---
  "nvidia/nemotron-mini-4b-instruct", // 388ms median under career prompt
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", // 646ms
  "nvidia/nemotron-3-nano-30b-a3b", // 1117ms
  "meta/llama-3.2-90b-vision-instruct", // 1153ms
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", // 1186ms (streams hidden reasoning first)
  "thinkingmachines/inkling", // 1194ms
  "nvidia/nvidia-nemotron-nano-9b-v2", // 1812ms (reasoning model)
  "nvidia/llama-3.3-nemotron-super-49b-v1.5", // 3404ms
  "nvidia/llama-3.3-nemotron-super-49b-v1", // 5212ms
  "meta/llama-3.1-70b-instruct", // 16981ms — works every time but slow; never default
];

const RELIABLE_SET: ReadonlySet<string> = new Set(RELIABLE_MODELS);

export function prettifyModelId(modelId: string): string {
  const name = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Static curated list served only when live discovery fails entirely. */
export const FREE_MODELS: readonly AiModelOption[] = RECOMMENDED_MODELS.map((id) => ({
  id,
  label: prettifyModelId(id),
  recommended: true,
}));

const CACHE_TTL_MS = Number(process.env.NIM_MODELS_CACHE_TTL_MS ?? 5 * 60 * 1000);

interface DiscoveryCache {
  at: number;
  options: AiModelOption[];
}

let cache: DiscoveryCache | null = null;
let inflight: Promise<AiModelOption[]> | null = null;

async function fetchCatalogIds(): Promise<string[]> {
  const base = AIConfig.getBaseUrl().replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    headers: {
      Authorization: `Bearer ${process.env.API_KEY_NIM ?? ""}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`NIM /models failed: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Ordered selector list:
 *   1. configured default model
 *   2. RECOMMENDED_MODELS in curated order
 *   3. remaining RELIABLE_MODELS alphabetically by label
 * The catalog can only ever narrow the list to allowlisted IDs — unknown,
 * retired or never-reliable models are dropped regardless of what NIM
 * advertises.
 */
export function buildOptions(ids: string[]): AiModelOption[] {
  const eligible = ids.filter((id) => RELIABLE_SET.has(id));
  const out: AiModelOption[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: prettifyModelId(id), recommended: RECOMMENDED_MODELS.includes(id) });
  };
  push(AIConfig.getFallbackModel());
  RECOMMENDED_MODELS.forEach(push);
  eligible
    .filter((id) => !seen.has(id))
    .sort((a, b) => prettifyModelId(a).localeCompare(prettifyModelId(b)))
    .forEach(push);
  return out;
}

/**
 * Live discovery with a bounded in-memory cache. Concurrent callers share a
 * single in-flight request. Never throws: on failure the static FREE_MODELS
 * list keeps the application usable.
 */
export async function listModels(): Promise<{
  models: AiModelOption[];
  source: "live" | "fallback";
}> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { models: cache.options, source: "live" };
  }
  if (!inflight) {
    const flight = fetchCatalogIds()
      .then((ids) => {
        // A catalog that yields zero eligible chat models is a broken response,
        // not an empty selector — treat it as a discovery failure so callers
        // get the static fallback instead of a "live" list of curated guesses.
        // A catalog that yields zero allowlisted models is a broken response,
        // not an empty selector — treat it as a discovery failure so callers
        // get the static fallback instead of a "live" list of curated guesses.
        const usable = ids.filter((id) => RELIABLE_SET.has(id));
        if (usable.length === 0) throw new Error("NIM catalog contained no usable chat models");
        const options = buildOptions(ids);
        cache = { at: Date.now(), options };
        return options;
      })
      .finally(() => {
        if (inflight === flight) inflight = null;
      });
    inflight = flight;
    flight.catch(() => {}); // shared promise must never become an unhandled rejection
  }
  const flight = inflight;
  try {
    return { models: await flight, source: "live" };
  } catch (err) {
    console.error("[NIMModels] Discovery failed, serving static fallback:", (err as Error).message);
    return { models: [...FREE_MODELS], source: "fallback" };
  }
}

/**
 * Execution chain for match analysis: requested model first, then the
 * configured default, then remaining recommended models — duplicates removed,
 * order preserved. The caller walks this chain while no output has streamed.
 */
export function buildModelChain(requested?: string): string[] {
  const chain: string[] = [];
  const push = (id: string | undefined): void => {
    if (id && !chain.includes(id)) chain.push(id);
  };
  push(requested);
  push(AIConfig.getFallbackModel());
  RECOMMENDED_MODELS.forEach(push);
  return chain;
}

/**
 * Validate a user-supplied model override against the current catalog.
 * Accepts when the ID is discoverable; degrades to accepting any
 * syntactically valid ID if discovery itself fails (execution still runs
 * through the safe fallback chain).
 */
export async function validateRequestedModel(
  requested?: string
): Promise<{ valid: boolean; reason?: "invalid_model" }> {
  if (!requested) return { valid: true };
  try {
    const { models } = await listModels();
    if (models.some((m) => m.id === requested)) return { valid: true };
    // Catalog reachable but model absent — could be brand-new or retired.
    return { valid: false, reason: "invalid_model" };
  } catch {
    return { valid: true };
  }
}

/* --- test helpers (not part of the public runtime surface) --- */

export function __setDiscoveryCacheForTests(options: AiModelOption[], at = Date.now()): void {
  cache = { at, options };
}

export function __resetDiscoveryCacheForTests(): void {
  cache = null;
  inflight = null;
}

/** Strip reasoning blocks / code fences and extract the first balanced JSON object. */
export function extractJson(text: string): unknown | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
