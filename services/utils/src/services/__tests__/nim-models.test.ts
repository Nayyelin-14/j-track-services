import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import AIConfig from "../../config/ai";
import {
  looksLikeChatModel,
  prettifyModelId,
  EXCLUDED_MODELS,
  RECOMMENDED_MODELS,
  RELIABLE_MODELS,
  FREE_MODELS,
  buildOptions,
  listModels,
  buildModelChain,
  validateRequestedModel,
  extractJson,
  __setDiscoveryCacheForTests,
  __resetDiscoveryCacheForTests,
} from "../nim-models";

vi.mock("../../config/ai", () => ({
  default: {
    getBaseUrl: vi.fn(() => "https://integrate.api.nvidia.com/v1"),
    getFallbackModel: vi.fn(() => "meta/llama-3.1-8b-instruct"),
  },
}));

const DEFAULT_MODEL = "meta/llama-3.1-8b-instruct";

function mockCatalog(ids: string[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  __resetDiscoveryCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("looksLikeChatModel", () => {
  it("accepts ordinary instruct/chat models", () => {
    expect(looksLikeChatModel("meta/llama-3.1-8b-instruct")).toBe(true);
    expect(looksLikeChatModel("poolside/laguna-xs-2.1")).toBe(true);
    expect(looksLikeChatModel("mistralai/mistral-nemotron")).toBe(true);
  });

  it("rejects embedding / retrieval / safety / speech families by documented purpose", () => {
    const rejected = [
      "nvidia/nv-embedqa-e5-v5",
      "baai/bge-m3",
      "snowflake/arctic-embed-l",
      "nvidia/llama-3.2-nv-rerankqa-1b-v2",
      "nvidia/nvclip",
      "nvidia/riva-translate-4b-instruct",
      "nvidia/aim-groundedness-guard",
      "google/deplot",
      "adept/fuyu-8b",
      "microsoft/kosmos-2",
      "meta/speech-to-text-en-US",
      "openai/voice-agent-large",
    ];
    rejected.forEach((id) => expect(looksLikeChatModel(id)).toBe(false));
  });
});

describe("prettifyModelId", () => {
  it("turns vendor-prefixed IDs into readable labels", () => {
    expect(prettifyModelId("meta/llama-3.1-8b-instruct")).toBe("Llama 3.1 8b Instruct");
    expect(prettifyModelId("poolside/laguna-xs-2.1")).toBe("Laguna Xs 2.1");
    expect(prettifyModelId("no-vendor-model")).toBe("No Vendor Model");
  });
});

describe("buildOptions", () => {
  it("orders default first, then recommended, then the rest alphabetically", () => {
    const options = buildOptions([
      ...[...RECOMMENDED_MODELS].reverse(),
      "nvidia/nemotron-mini-4b-instruct",
      "thinkingmachines/inkling",
    ]);

    expect(options[0].id).toBe(DEFAULT_MODEL);
    // RECOMMENDED_MODELS[0] IS the default — dedup collapses it, so the
    // remaining recommended entries follow in curated order.
    const recommendedRest = RECOMMENDED_MODELS.filter((id) => id !== DEFAULT_MODEL);
    recommendedRest.forEach((id, i) => expect(options[i + 1].id).toBe(id));
    const tail = options.slice(recommendedRest.length + 1).map((o) => o.id);
    expect(tail).toEqual([...tail].sort((a, b) => prettifyModelId(a).localeCompare(prettifyModelId(b))));
    expect(tail).toContain("nvidia/nemotron-mini-4b-instruct");
    expect(tail).toContain("thinkingmachines/inkling");
  });

  it("drops anything outside the reliability allowlist", () => {
    const options = buildOptions([
      "nvidia/nv-embedqa-e5-v5",
      "01-ai/yi-large", // excluded: verified HTTP 404 at inference time
      "mistralai/mistral-nemotron", // intermittent >30s stalls under career prompt
      "minimaxai/minimax-m3", // fails on every career-prompt request
      "poolside/laguna-xs-2.1", // works, but erratic first-token latency
    ]);
    // Only curated defaults/recommended are ever synthesized — nothing
    // outside the allowlist leaks in.
    for (const o of options) expect(RELIABLE_MODELS).toContain(o.id);
  });

  it("flags exactly the curated recommended models and dedupes inputs", () => {
    const options = buildOptions([DEFAULT_MODEL, ...RECOMMENDED_MODELS, DEFAULT_MODEL]);
    expect(options.filter((o) => o.recommended)).toHaveLength(RECOMMENDED_MODELS.length);
    expect(options.filter((o) => o.id === DEFAULT_MODEL)).toHaveLength(1);
  });
});

describe("listModels", () => {
  it("serves a fresh cache without hitting the network", async () => {
    const cached = [{ id: "cached/model", label: "Cached Model", recommended: false }];
    __setDiscoveryCacheForTests(cached);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { models, source } = await listModels();

    expect(source).toBe("live");
    expect(models).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches once the cache has expired", async () => {
    __setDiscoveryCacheForTests(
      [{ id: "stale/model", label: "Stale Model", recommended: false }],
      Date.now() - 10 * 60 * 1000,
    );
    mockCatalog(["fresh/model", "nvidia/nemotron-mini-4b-instruct"]);

    const { models, source } = await listModels();

    expect(source).toBe("live");
    expect(models.map((m) => m.id)).toContain("nvidia/nemotron-mini-4b-instruct");
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchMock = mockCatalog(["nvidia/nemotron-mini-4b-instruct", "meta/muse-glimmer-30b"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(() =>
      gate.then(() => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "nvidia/nemotron-mini-4b-instruct" }, { id: "meta/muse-glimmer-30b" }] }),
      })),
    );

    // Back-to-back synchronous calls must share the single in-flight request…
    const p1 = listModels();
    const p2 = listModels();
    const p3 = listModels();
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.source).toBe("live");
    expect(r2.models).toEqual(r1.models);
    expect(r3.models).toEqual(r1.models);
  });

  it("falls back to the static curated list when discovery fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const { models, source } = await listModels();

    expect(source).toBe("fallback");
    expect(models.map((m) => m.id)).toEqual([...RECOMMENDED_MODELS]);
    expect(models.every((m) => m.recommended)).toBe(true);
    expect(models).toEqual([...FREE_MODELS]);
  });

  it("falls back when the catalog contains no usable chat models", async () => {
    mockCatalog(["nvidia/nv-embedqa-e5-v5", ...EXCLUDED_MODELS].slice(0, 5));

    const { source, models } = await listModels();

    expect(source).toBe("fallback");
    expect(models.length).toBeGreaterThan(0);
  });

  it("sends auth headers to the configured NIM base URL", async () => {
    process.env.API_KEY_NIM = "nvapi-test-key";
    const fetchMock = mockCatalog(["x/model"]);
    await listModels();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer nvapi-test-key");
  });
});

describe("buildModelChain", () => {
  // The curated list starts with the default model, so the deduped chain is
  // [default, gpt-oss-20b, nemotron-3-super-120b, mistral-nemotron, vision-11b].
  const FULL_CHAIN = [
    DEFAULT_MODEL,
    ...RECOMMENDED_MODELS.filter((id) => id !== DEFAULT_MODEL),
  ];

  it("starts at the default and walks every recommended model when nothing is selected", () => {
    expect(buildModelChain()).toEqual(FULL_CHAIN);
    expect(buildModelChain()).toHaveLength(5);
  });

  it("puts the requested model first and removes duplicates", () => {
    expect(buildModelChain(DEFAULT_MODEL)).toEqual(FULL_CHAIN);
    expect(
      buildModelChain("meta/muse-glimmer-30b"),
    ).toEqual([
      "meta/muse-glimmer-30b",
      DEFAULT_MODEL,
      "openai/gpt-oss-20b",
      "nvidia/nemotron-3-super-120b-a12b",
      "meta/llama-3.2-11b-vision-instruct",
    ]);
    expect(new Set(buildModelChain("meta/llama-3.1-8b-instruct")).size).toBe(5);
  });
});

describe("validateRequestedModel", () => {
  it("accepts an empty selection", async () => {
    await expect(validateRequestedModel(undefined)).resolves.toEqual({ valid: true });
  });

  it("accepts an allowlisted model present in the live catalog", async () => {
    mockCatalog(["meta/llama-3.1-8b-instruct", "openai/gpt-oss-20b"]);
    await expect(validateRequestedModel("openai/gpt-oss-20b")).resolves.toEqual({ valid: true });
  });

  it("rejects a cataloged model that is not on the allowlist", async () => {
    mockCatalog(["meta/llama-3.1-8b-instruct", "weird/but-cataloged"]);
    await expect(validateRequestedModel("weird/but-cataloged")).resolves.toEqual({
      valid: false,
      reason: "invalid_model",
    });
  });

  it("rejects an ID absent from the reachable catalog", async () => {
    mockCatalog(["meta/llama-3.1-8b-instruct"]);
    await expect(validateRequestedModel("ghost/model")).resolves.toEqual({
      valid: false,
      reason: "invalid_model",
    });
  });

  it("degrades to accepting when discovery fails entirely", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
    // Fallback list keeps recommended IDs usable…
    await expect(validateRequestedModel("openai/gpt-oss-20b")).resolves.toEqual({ valid: true });
    // …anything else cannot be confirmed and is treated as invalid.
    await expect(validateRequestedModel("obscure/model")).resolves.toEqual({
      valid: false,
      reason: "invalid_model",
    });
  });
});

describe("extractJson", () => {
  it("parses plain JSON objects", () => {
    expect(extractJson('{"matchScore":85}')).toEqual({ matchScore: 85 });
  });

  it("parses markdown-fenced JSON", () => {
    expect(extractJson('```json\n{"matchScore":72}\n```')).toEqual({ matchScore: 72 });
  });

  it("strips reasoning blocks before parsing", () => {
    expect(extractJson('<think>hmm {"decoy":1}</think>{"matchScore":9}')).toEqual({ matchScore: 9 });
  });

  it("handles nested objects and braces inside strings", () => {
    const text = '{"outer":{"inner":"has \\"braces\\" } inside"},"tail":1}';
    expect(extractJson(text)).toEqual({ outer: { inner: 'has "braces" } inside' }, tail: 1 });
  });

  it("returns null for garbage or unbalanced input", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"broken": ')).toBeNull();
    expect(extractJson('{"bad": json}')).toBeNull();
  });
});
