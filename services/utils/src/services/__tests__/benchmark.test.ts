import { describe, it, expect, vi } from "vitest";
import AIConfig from "../../config/ai";
import { scoreQuality, buildCandidateIds, computeComposites, type BenchResult } from "../../../scripts/run-benchmark";

vi.mock("../../config/ai", () => ({
  default: {
    getFallbackModel: vi.fn(() => "meta/llama-3.1-8b-instruct"),
  },
}));

const DEFAULT_MODEL = "meta/llama-3.1-8b-instruct";

/** A fixture-perfect answer: all present skills in strengths, planted-missing
 * skills in gaps, in-band score, aligned recommendation, no code fence. */
function perfectOutput(score = 85): { parsed: any; raw: string } {
  const parsed = {
    matchScore: score,
    strengths: [
      "Deep React experience",
      "Strong TypeScript skills",
      "Built and maintained a design system",
      "Wrote comprehensive tests",
    ],
    gaps: ["No GraphQL exposure", "Limited CI/CD pipeline experience"],
    recommendation: "yes",
    recommendationReason: "Core stack aligns with the posting",
    summary: "Strong fit",
    fullAnalysis: "Candidate matches the required profile closely.",
  };
  return { parsed, raw: JSON.stringify(parsed) };
}

describe("scoreQuality", () => {
  it("scores a schema-perfect, discriminating answer at or near 100", () => {
    const { parsed, raw } = perfectOutput();
    expect(scoreQuality(parsed, raw)).toBeGreaterThanOrEqual(95);
  });

  it("returns zero when the output cannot be parsed", () => {
    expect(scoreQuality(null, "garbage")).toBe(0);
  });

  it("caps below the compliance floor without a usable matchScore", () => {
    expect(scoreQuality({ strengths: ["react"] }, "{}")).toBeLessThanOrEqual(18);
  });

  it("rewards only identified skills — partial identification loses points", () => {
    const { parsed, raw } = perfectOutput();
    const half = { ...parsed, strengths: ["React experience"], gaps: [] };
    expect(scoreQuality(half, raw)).toBeLessThan(scoreQuality(parsed, raw));
  });

  it("penalises out-of-band scores and markdown fences", () => {
    const good = perfectOutput();
    const offBand = perfectOutput(10);
    expect(scoreQuality(offBand.parsed, offBand.raw)).toBeLessThan(scoreQuality(good.parsed, good.raw));

    const fenced = perfectOutput();
    expect(scoreQuality(fenced.parsed, "```json\n" + fenced.raw + "\n```")).toBe(
      scoreQuality(fenced.parsed, fenced.raw) - 4,
    );
  });
});

describe("buildCandidateIds", () => {
  it("force-includes the default and recommended models even if absent from the catalog", () => {
    const candidates = buildCandidateIds(["some/other-model"]);
    expect(candidates[0]).toBe(DEFAULT_MODEL);
    for (const id of ["openai/gpt-oss-20b", "nvidia/nemotron-3-super-120b-a12b"]) {
      expect(candidates).toContain(id);
    }
  });

  it("filters non-chat and excluded catalog IDs and dedupes", () => {
    const candidates = buildCandidateIds([
      DEFAULT_MODEL,
      "nvidia/nv-embedqa-e5-v5",
      "01-ai/yi-large",
      "zeta/chat",
    ]);
    expect(candidates.filter((id) => id === DEFAULT_MODEL)).toHaveLength(1);
    expect(candidates).not.toContain("nvidia/nv-embedqa-e5-v5");
    expect(candidates).not.toContain("01-ai/yi-large");
    expect(candidates).toContain("zeta/chat");
  });
});

describe("computeComposites", () => {
  function result(overrides: Partial<BenchResult>): BenchResult {
    return {
      id: "x/model",
      working: true,
      successCount: 1,
      trials: 1,
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
      ...overrides,
    };
  }

  it("applies the documented formula: 50% quality + 25% speed + 25% token efficiency", () => {
    const fast = result({ id: "a/fast", qualityScore: 88, avgLatencyMs: 1000, avgTotalTokens: 200 });
    const slow = result({ id: "b/slow", qualityScore: 88, avgLatencyMs: 4000, avgTotalTokens: 200 });
    computeComposites([fast, slow]);

    // fast is best on both axes → speed & efficiency both 100.
    expect(fast.speedScore).toBe(100);
    expect(fast.tokenEfficiencyScore).toBe(100);
    expect(fast.overallScore).toBeCloseTo(94, 1);

    // slow needs 4x the best latency → full 25-point speed penalty.
    expect(slow.speedScore).toBeCloseTo(25, 1);
    expect(slow.overallScore).toBeCloseTo(75.3, 1);
    expect(fast.rank).toBe(1);
    expect(slow.rank).toBe(2);
  });

  it("ranks non-working models last with an overall score of zero", () => {
    const ok = result({ id: "a/ok", qualityScore: 60, avgLatencyMs: 5000, avgTotalTokens: 500 });
    const dead = result({ id: "z/dead", working: false, error: "HTTP 404" });
    computeComposites([dead, ok]);

    expect(dead.overallScore).toBe(0);
    expect(ok.rank).toBe(1);
    expect(dead.rank).toBe(2);
  });

  it("treats missing usage data as a neutral 50 efficiency instead of crashing", () => {
    const noUsage = result({ id: "a/nousage", qualityScore: 80, avgLatencyMs: 2000, avgTotalTokens: null });
    computeComposites([noUsage]);
    expect(noUsage.tokenEfficiencyScore).toBe(50);
    expect(noUsage.overallScore).toBeCloseTo(0.5 * 80 + 25 + 12.5, 1);
  });

  it("breaks ties deterministically by latency, then id", () => {
    // Identical metrics → identical overall scores; faster model wins…
    const c = result({ id: "m/c", qualityScore: 90, avgLatencyMs: 2500, avgTotalTokens: 300 });
    const d = result({ id: "m/d", qualityScore: 90, avgLatencyMs: 2500, avgTotalTokens: 300 });
    computeComposites([c, d]);
    expect(c.overallScore).toBe(d.overallScore);
    expect(c.rank).toBe(1); // equal everything except id → alphabetical

    // …and at equal cost axes, higher quality always wins outright.
    const a = result({ id: "m/a", qualityScore: 90, avgLatencyMs: 3000, avgTotalTokens: 300 });
    const b = result({ id: "m/b", qualityScore: 92, avgLatencyMs: 3000, avgTotalTokens: 300 });
    computeComposites([a, b]);
    expect(b.overallScore).toBeGreaterThan(a.overallScore);
    expect(b.rank).toBe(1);
  });
});
