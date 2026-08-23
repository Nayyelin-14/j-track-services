/**
 * Offline NIM model benchmark for the Job Match Analysis workload.
 *
 * Developer/maintenance tool — NEVER part of the request path. Runtime
 * recommendations come from RECOMMENDED_MODELS in src/services/nim-models.ts,
 * which humans curate after reviewing this script's output.
 *
 * Run from services/utils:
 *   npx tsx scripts/run-benchmark.ts [trials] [model1,model2,...]
 *
 * Flow: discover all chat-capable catalog models → explicit exclusions →
 * probe each candidate → benchmark EVERY working model on a fixed realistic
 * fixture → measure quality / latency / token usage → composite ranking
 * (50% quality, 25% speed, 25% token efficiency) → CSV + Markdown reports.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import AIConfig from "../src/config/ai.js";
import {
  EXCLUDED_MODELS,
  RECOMMENDED_MODELS,
  extractJson,
  looksLikeChatModel,
} from "../src/services/nim-models.js";

/* ------------------------------------------------------------------ */
/* Deterministic Job Match Analysis fixture                            */
/* ------------------------------------------------------------------ */

const FIXTURE_SYSTEM_PROMPT = [
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

/**
 * Strong-but-not-perfect candidate against a frontend role:
 * - present skills that SHOULD surface as strengths (15 pts each bucket)
 * - required skills deliberately missing from the resume that SHOULD be
 *   reported as gaps — a model that misses them is inventing coverage
 * - expected matchScore lands in [68, 92]; recommendation yes/maybe
 */
const FIXTURE_USER_PROMPT = [
  "RESUME TEXT:",
  '"""',
  "Sarah Chen — Senior Frontend Engineer, 8 years of experience.",
  "Skills: React, TypeScript, JavaScript (ES6+), Redux, HTML5, CSS3, Tailwind CSS,",
  "Jest, React Testing Library, Cypress, Webpack, Vite, design systems, accessibility (WCAG),",
  "Git, Agile/Scrum. Led a design-system team of 4; mentored junior developers.",
  "Experience: built high-traffic e-commerce frontends serving 2M monthly users;",
  "migrated a legacy jQuery app to React+TypeScript; introduced component library",
  "adopted by 5 product teams; set up unit and E2E testing practices.",
  "Education: B.S. Computer Science, University of Washington, 2017.",
  '"""',
  "",
  "JOB POSTING:",
  "Title: Senior Frontend Engineer",
  "Description: Join our platform team to build customer-facing web applications.",
  "Responsibilities: develop and maintain React applications, own feature delivery",
  "end to end, collaborate with designers and backend engineers, mentor juniors.",
  "Required Skills: React, TypeScript, GraphQL, CI/CD pipelines, 5+ years experience",
  "Preferred Skills: Next.js, Redux, design systems, automated testing",
  "Experience Required: 5 years",
  "Education: B.S. in Computer Science or related field",
].join("\n");

const PRESENT_SKILL_KEYWORDS = ["react", "typescript", "design system", "test"];
const MISSING_SKILL_KEYWORDS = ["graphql", "ci/cd"];
const SCORE_BAND = { min: 68, max: 92 };

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

interface ParsedAnalysis {
  matchScore?: unknown;
  strengths?: unknown;
  gaps?: unknown;
  recommendation?: unknown;
  recommendationReason?: unknown;
  summary?: unknown;
  fullAnalysis?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function keywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k)).length;
}

/**
 * Deterministic quality score (0-100) for one fixture response:
 *   50 pts schema compliance (parse gate, fields, types, ranges)
 *   30 pts skill identification (present→strengths, missing→gaps)
 *   20 pts judgment (score band, recommendation alignment, no fence)
 * Length is never rewarded directly — usefulness is what is measured.
 */
export function scoreQuality(parsed: ParsedAnalysis | null, rawOutput: string): number {
  if (!parsed || typeof parsed !== "object") return 0;

  let score = 0;
  if (typeof parsed.matchScore === "number") {
    score += 10;
    if (parsed.matchScore >= 0 && parsed.matchScore <= 100) score += 8;
  } else {
    return Math.min(score, 18); // no usable matchScore → cap below compliance floor
  }
  const strengths = asStringArray(parsed.strengths);
  const gaps = asStringArray(parsed.gaps);
  if (strengths.length > 0) score += 6;
  if (gaps.length > 0) score += 6;
  if (parsed.recommendation === "yes" || parsed.recommendation === "maybe" || parsed.recommendation === "no") score += 5;
  if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) score += 5;
  if (typeof parsed.fullAnalysis === "string" && parsed.fullAnalysis.trim().length > 0) score += 5;
  if (typeof parsed.recommendationReason === "string" && parsed.recommendationReason.trim().length > 0) score += 5;

  // Skill identification: present skills should appear in strengths,
  // planted-missing skills MUST appear in gaps.
  const strengthsText = strengths.join(" ");
  const gapsText = gaps.join(" ");
  score += Math.round(15 * (keywordHits(strengthsText, PRESENT_SKILL_KEYWORDS) / PRESENT_SKILL_KEYWORDS.length));
  score += Math.round(15 * (keywordHits(gapsText, MISSING_SKILL_KEYWORDS) / MISSING_SKILL_KEYWORDS.length));

  // Judgment: expected band + aligned recommendation + clean formatting.
  const s = parsed.matchScore as number;
  const mid = (SCORE_BAND.min + SCORE_BAND.max) / 2;
  if (s >= SCORE_BAND.min && s <= SCORE_BAND.max) score += 12;
  else if (Math.abs(s - mid) <= 12) score += 6;
  score += parsed.recommendation === "yes" || parsed.recommendation === "maybe" ? 4 : 0;
  if (!rawOutput.includes("```")) score += 4;

  return Math.max(0, Math.min(100, score));
}

/* ------------------------------------------------------------------ */
/* Candidate selection                                                 */
/* ------------------------------------------------------------------ */

/** Catalog IDs → benchmark candidates. Never hardcoded; default and the
 * curated recommended models are force-included so they can't silently
 * drift out of comparison. */
export function buildCandidateIds(catalogIds: string[]): string[] {
  const out: string[] = [];
  const push = (id: string | undefined): void => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(AIConfig.getFallbackModel());
  RECOMMENDED_MODELS.forEach(push);
  catalogIds
    .filter((id) => looksLikeChatModel(id) && !EXCLUDED_MODELS.has(id))
    .sort()
    .forEach(push);
  return out;
}

/* ------------------------------------------------------------------ */
/* Composite ranking                                                   */
/* ------------------------------------------------------------------ */

export interface BenchResult {
  id: string;
  working: boolean;
  successCount: number;
  trials: number;
  avgLatencyMs: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgTotalTokens: number | null;
  qualityScore: number | null;
  speedScore: number | null;
  tokenEfficiencyScore: number | null;
  overallScore: number;
  rank: number | null;
  error: string | null;
}

/**
 * Normalization (documented in every report):
 *   speedScore        = 100 × bestLatency  / modelLatency
 *   tokenEfficiency   = 100 × fewestTokens / modelTokens
 *   overallScore      = 0.50×quality + 0.25×speedScore + 0.25×tokenEfficiency
 *
 * Both cost axes are best-relative, so raw milliseconds/tokens can never
 * outweigh quality: a model needs ~4x the best latency to lose a full 25
 * points, while quality swings decide rankings. Non-working models score 0
 * and sort below every working one.
 */
export function computeComposites(results: BenchResult[]): void {
  const ok = results.filter((r) => r.working && r.avgLatencyMs != null);
  const withTokens = ok.filter((r) => r.avgTotalTokens != null);
  const bestLatency = ok.length ? Math.min(...ok.map((r) => r.avgLatencyMs!)) : null;
  const bestTokens = withTokens.length ? Math.min(...withTokens.map((r) => r.avgTotalTokens!)) : null;

  for (const r of results) {
    if (!r.working || r.qualityScore == null) {
      r.speedScore = null;
      r.tokenEfficiencyScore = null;
      r.overallScore = 0;
      continue;
    }
    r.speedScore = bestLatency ? round1(100 * bestLatency / r.avgLatencyMs!) : 50;
    r.tokenEfficiencyScore =
      bestTokens && r.avgTotalTokens ? round1(100 * bestTokens / r.avgTotalTokens) : 50;
    r.overallScore = round1(
      0.5 * r.qualityScore +
        0.25 * r.speedScore +
        0.25 * (r.tokenEfficiencyScore ?? 50),
    );
  }

  const ranked = [...results].sort(
    (a, b) =>
      b.overallScore - a.overallScore ||
      (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
      (a.avgLatencyMs ?? Infinity) - (b.avgLatencyMs ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------ */
 /* Live runner                                                         */
/* ------------------------------------------------------------------ */

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

async function chatOnce(
  modelId: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
  timeoutMs: number,
): Promise<{ content: string; usage: { prompt: number | null; completion: number | null; total: number | null }; latencyMs: number }> {
  const ai = AIConfig.getInstance();
  const t0 = Date.now();
  const res = (await ai.chat.completions.create(
    { model: modelId, messages, max_tokens: maxTokens, temperature: 0.3 },
    { timeout: timeoutMs },
  )) as ChatResponse;
  const choice = res.choices?.[0]?.message;
  // Reasoning models may place the answer entirely in `reasoning`.
  const content = (choice?.content ?? choice?.reasoning ?? "").trim();
  return {
    content,
    usage: {
      prompt: res.usage?.prompt_tokens ?? null,
      completion: res.usage?.completion_tokens ?? null,
      total: res.usage?.total_tokens ?? null,
    },
    latencyMs: Date.now() - t0,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCatalogIds(): Promise<string[]> {
  const base = AIConfig.getBaseUrl().replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    headers: {
      Authorization: `Bearer ${process.env.API_KEY_NIM ?? ""}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discovery failed: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((e) => e.id).filter((id): id is string => typeof id === "string");
}

async function main(): Promise<void> {
  if (!process.env.API_KEY_NIM) {
    console.error("API_KEY_NIM is not set.");
    process.exit(1);
  }
  const trials = Math.max(1, Number(process.argv[2]) || 1);
  const restricted = process.argv[3]
    ? new Set(process.argv[3].split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  console.info("Discovering NIM catalog…");
  let candidates = buildCandidateIds(await fetchCatalogIds());
  if (restricted) candidates = candidates.filter((id) => restricted.has(id));
  console.info(`${candidates.length} chat-capable candidates after filters.`);

  // Probe: cheap health check so obviously-dead models are not benchmarked.
  const probeResults = await mapWithConcurrency(candidates, 4, async (id) => {
    try {
      await chatOnce(id, [{ role: "user", content: "Reply with exactly: NIM_HEALTH_OK" }], 16, 20_000);
      return { id, working: true, error: null as string | null };
    } catch (err) {
      return { id, working: false, error: firstLine(err instanceof Error ? err.message : String(err)) };
    }
  });
  const working = probeResults.filter((p) => p.working).map((p) => p.id);
  const dead = probeResults.filter((p) => !p.working);
  console.info(`${working.length}/${candidates.length} passed the health probe. Benchmarking all of them…`);

  const results: BenchResult[] = [];
  for (let i = 0; i < working.length; i++) {
    const id = working[i]!;
    process.stdout.write(`[${i + 1}/${working.length}] benchmarking ${id} … `);
    const result = await benchmarkModel(id, trials);
    results.push(result);
    console.log(
      result.working
        ? `Q${result.qualityScore?.toFixed(1)} · ${result.avgLatencyMs}ms · ${result.avgTotalTokens ?? "?"} tok`
        : `FAILED (${result.error})`,
    );
    if (i < working.length - 1) await sleep(1200); // stay friendly to rate limits
  }

  // Dead probes join the report so nothing disappears silently.
  for (const d of dead) {
    results.push({
      id: d.id,
      working: false,
      successCount: 0,
      trials,
      avgLatencyMs: null,
      avgInputTokens: null,
      avgOutputTokens: null,
      avgTotalTokens: null,
      qualityScore: null,
      speedScore: null,
      tokenEfficiencyScore: null,
      overallScore: 0,
      rank: null,
      error: d.error,
    });
  }

  computeComposites(results);
  await writeReports(results, trials);

  const top = results.filter((r) => r.working).slice(0, 5);
  console.info(`\n★ TOP ${top.length}${top.length === 1 ? "" : ""} (of ${working.length} working)\n`);
  top.forEach((r, i) => console.info(`${i + 1}. ${r.id}`));
  console.info("\nCurate these into RECOMMENDED_MODELS in src/services/nim-models.ts after review.");
  process.exit(0);
}

async function benchmarkModel(modelId: string, trials: number): Promise<BenchResult> {
  const base: BenchResult = {
    id: modelId,
    working: false,
    successCount: 0,
    trials,
    avgLatencyMs: null,
    avgInputTokens: null,
    avgOutputTokens: null,
    avgTotalTokens: null,
    qualityScore: null,
    speedScore: null,
    tokenEfficiencyScore: null,
    overallScore: 0,
    rank: null,
    error: null,
  };

  const latencies: number[] = [];
  const inputs: number[] = [];
  const outputs: number[] = [];
  const totals: number[] = [];
  const qualities: number[] = [];
  let lastError: string | null = null;

  for (let t = 0; t < trials; t++) {
    try {
      const r = await chatOnce(
        modelId,
        [
          { role: "system", content: FIXTURE_SYSTEM_PROMPT },
          { role: "user", content: FIXTURE_USER_PROMPT },
        ],
        2048,
        60_000,
      );
      if (!r.content) throw new Error("Empty response");
      latencies.push(r.latencyMs);
      if (r.usage.prompt != null) inputs.push(r.usage.prompt);
      if (r.usage.completion != null) outputs.push(r.usage.completion);
      if (r.usage.total != null) totals.push(r.usage.total);
      const parsed = extractJson(r.content) as ParsedAnalysis | null;
      qualities.push(scoreQuality(parsed, r.content));
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (qualities.length === 0) {
    return { ...base, error: lastError ?? "all trials failed" };
  }
  const avg = (xs: number[]): number | null =>
    xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
  return {
    ...base,
    working: true,
    successCount: qualities.length,
    avgLatencyMs: avg(latencies),
    avgInputTokens: avg(inputs),
    avgOutputTokens: avg(outputs),
    avgTotalTokens: avg(totals),
    qualityScore: round1(qualities.reduce((s, q) => s + q, 0) / qualities.length),
    error: lastError,
  };
}

function firstLine(message: string): string {
  const idx = message.indexOf("\n");
  const line = idx > 0 ? message.slice(0, idx) : message;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

async function writeReports(results: BenchResult[], trials: number): Promise<void> {
  const workingSorted = results.filter((r) => r.working).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const csv = [
    "model,status,successRate,qualityScore,avgLatencyMs,avgInputTokens,avgOutputTokens,avgTotalTokens,overallScore,rank,error",
    ...results.map((r) =>
      [
        r.id,
        r.working ? "working" : "failed",
        `${Math.round((r.successCount / r.trials) * 100)}%`,
        r.qualityScore ?? "",
        r.avgLatencyMs ?? "",
        r.avgInputTokens ?? "",
        r.avgOutputTokens ?? "",
        r.avgTotalTokens ?? "",
        r.working ? r.overallScore : "",
        r.rank ?? "",
        r.error ?? "",
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync("benchmark-results.csv", `${csv}\n`);

  const md: string[] = [
    "# NIM Model Benchmark — Job Match Analysis",
    "",
    `Generated: ${new Date().toISOString()} · trials/model: ${trials} · fixture: senior frontend engineer vs frontend posting (planted skills + deliberate gaps)`,
    "",
    "## Scoring formula",
    "",
    "- qualityScore (0-100): 50 schema compliance + 30 skill identification (present→strengths, missing→gaps) + 20 judgment (score band, recommendation, no code fence)",
    `- speedScore = 100 × bestLatency / modelLatency`,
    `- tokenEfficiency = 100 × fewestTokens / modelTokens`,
    "- **overallScore = 0.50 × quality + 0.25 × speed + 0.25 × token efficiency**",
    "",
    `## Ranking (${workingSorted.length} working models)`,
    "",
    "| Rank | Model | Quality | Speed | Tokens | Overall | Success |",
    "|---|---|---|---|---|---|---|",
    ...workingSorted.map(
      (r) =>
        `| ${r.rank} | ${r.id} | ${r.qualityScore ?? "-"} | ${
          r.speedScore ?? "-"
        } | ${r.avgTotalTokens ?? "n/a"} | ${r.overallScore} | ${Math.round(
          (r.successCount / r.trials) * 100,
        )}% |`,
    ),
    "",
    "## TOP 5",
    "",
    ...workingSorted.slice(0, 5).map((r, i) => `${i + 1}. ${r.id}`),
    "",
    "## Non-working models",
    "",
    ...results
      .filter((r) => !r.working)
      .map((r) => `- ${r.id} — ${r.error ?? "unknown error"}`),
    "",
  ];
  writeFileSync("benchmark-results.md", md.join("\n"));
  console.info("\nWrote benchmark-results.csv and benchmark-results.md");
}

function csvEscape(value: string | number | null): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Run only when invoked directly (`npx tsx scripts/run-benchmark.ts`) —
   importing the module (e.g. from tests) must stay side-effect free. */
const isDirectRun =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark aborted:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
