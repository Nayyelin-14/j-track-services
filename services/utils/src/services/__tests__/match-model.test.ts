import { describe, it, expect, vi, beforeEach } from "vitest";
import matchService from "../match";
import AIConfig from "../../config/ai";

vi.mock("../../config/ai", () => ({
  default: {
    getInstance: vi.fn(),
    getModel: vi.fn(() => "meta/llama-3.1-8b-instruct"),
    getFallbackModel: vi.fn(() => "meta/llama-3.1-8b-instruct"),
    getBaseUrl: vi.fn(() => "https://integrate.api.nvidia.com/v1"),
  },
}));

const { mockNimModels } = vi.hoisted(() => ({
  mockNimModels: {
    validateRequestedModel: vi.fn(async (requested?: string) =>
      !requested || requested !== "unknown/model" ? { valid: true } : { valid: false, reason: "invalid_model" as const },
    ),
    buildModelChain: vi.fn((requested?: string) => {
      const chain: string[] = [];
      const push = (id?: string) => {
        if (id && !chain.includes(id)) chain.push(id);
      };
      push(requested);
      push("meta/llama-3.1-8b-instruct");
      push("poolside/laguna-xs-2.1");
      return chain;
    }),
  },
}));

vi.mock("../nim-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nim-models")>();
  return { ...actual, ...mockNimModels };
});

function createMockResponse() {
  const write = vi.fn().mockReturnValue(true);
  return {
    write,
    writableEnded: false,
    end: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    on: vi.fn(),
  } as unknown as import("express").Response;
}

async function* asyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of yieldAll(items)) yield item;
}

function* yieldAll<T>(items: T[]): Generator<T> {
  yield* items;
}

function chunk(text: string | null, extra: Record<string, unknown> = {}) {
  return {
    choices: [{ delta: { content: text }, index: 0 }],
    ...(Object.keys(extra).length ? extra : {}),
  } as never;
}

const GOOD = '{"matchScore":77,"strengths":["TS"],"gaps":["k8s"],"recommendation":"yes","recommendationReason":"r","summary":"s","fullAnalysis":"f"}';

function setupNim(createImpl: (...args: any[]) => Promise<unknown>) {
  const create = vi.fn(createImpl);
  vi.mocked(AIConfig.getInstance).mockReturnValue({
    chat: { completions: { create } },
  } as never);
  return create;
}

const job = {
  title: "Engineer",
  description: "Build things",
  salary: null,
  location: undefined,
  job_type: undefined,
  work_location: undefined,
  role: undefined,
  company_name: undefined,
};

function eventsOf(res: import("express").Response) {
  const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
  return writeCalls.map(([data]) => JSON.parse(data.replace(/^data: /, "").replace(/\n\n$/, "")));
}

describe("model selection in streamMatchAnalysis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(matchService as any, "downloadAndParseResume").mockResolvedValue("resume text with TypeScript skills");
    mockNimModels.validateRequestedModel.mockClear();
    mockNimModels.buildModelChain.mockClear();
  });

  it("uses the selected model first and reports it in the complete event", async () => {
    const create = setupNim(() =>
      Promise.resolve(
        asyncIterable([
          chunk(GOOD.slice(0, 30)),
          chunk(GOOD.slice(30)),
          chunk(null, { usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } }),
        ]),
      ),
    );

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal, "user/pick");

    expect((create.mock.calls[0][0] as any).model).toBe("user/pick");
    const complete = eventsOf(res).find((e) => e.status === "complete");
    expect(complete.model_used).toBe("user/pick");
    expect(complete.usage).toEqual({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 });
    expect(typeof complete.latency_ms).toBe("number");
    expect(complete.result.matchScore).toBe(77);
  });

  it("defaults to the configured model with no fallback event when nothing is selected", async () => {
    setupNim(() => Promise.resolve(asyncIterable([chunk(GOOD)])));

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal);

    const evts = eventsOf(res);
    expect(evts.some((e) => e.status === "model_fallback")).toBe(false);
    expect(evts.find((e) => e.status === "complete").model_used).toBe("meta/llama-3.1-8b-instruct");
  });

  it("rejects an unknown override before execution and falls back to the default", async () => {
    const create = setupNim(() => Promise.resolve(asyncIterable([chunk(GOOD)])));

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal, "unknown/model");

    expect(mockNimModels.validateRequestedModel).toHaveBeenCalledWith("unknown/model");
    // Chain must start at the default, not at the invalid ID.
    expect(mockNimModels.buildModelChain).toHaveBeenCalledWith(undefined);
    expect((create.mock.calls[0][0] as any).model).toBe("meta/llama-3.1-8b-instruct");

    const fb = eventsOf(res).find((e) => e.status === "model_fallback");
    expect(fb.requested_model).toBe("unknown/model");
    expect(fb.used_model).toBe("meta/llama-3.1-8b-instruct");
    expect(fb.reason).toBe("invalid_model");
  });

  it("falls back to the next chain member when the requested model fails before streaming", async () => {
    let call = 0;
    const create = setupNim(() => {
      call++;
      if (call === 1) return Promise.reject(new Error("upstream overloaded"));
      return Promise.resolve(asyncIterable([chunk('{"matchScore":64,"strengths":["a"],"gaps":["b"],"recommendation":"maybe","recommendationReason":"r","summary":"s","fullAnalysis":"f"}')]));
    });

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal, "user/pick");

    expect(create.mock.calls.length).toBe(2);
    expect((create.mock.calls[0][0] as any).model).toBe("user/pick");
    expect((create.mock.calls[1][0] as any).model).toBe("meta/llama-3.1-8b-instruct");

    const fb = eventsOf(res).find((e) => e.status === "model_fallback");
    expect(fb.requested_model).toBe("user/pick");
    expect(fb.used_model).toBe("meta/llama-3.1-8b-instruct");
    expect(fb.reason).toBe("runtime_failure");

    const complete = eventsOf(res).find((e) => e.status === "complete");
    expect(complete.model_used).toBe("meta/llama-3.1-8b-instruct");
    expect(complete.result.matchScore).toBe(64);
  });

  it("never switches models after output has started streaming", async () => {
    const create = setupNim(() =>
      Promise.resolve(
        (async function* () {
          yield chunk('{"matchScore":85,"strengths":["partial"]');
          throw new Error("stream broke mid-response");
        })(),
      ),
    );

    const res = createMockResponse();
    await expect(
      matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal, "user/pick"),
    ).rejects.toThrow("stream broke mid-response");

    // Exactly one attempt — no second model may be tried once content streamed.
    expect(create.mock.calls.length).toBe(1);
    expect(eventsOf(res).some((e) => e.status === "complete")).toBe(false);
  });

  it("throws when every model in the chain fails", async () => {
    mockNimModels.buildModelChain.mockReturnValue(["a/one", "b/two"]);
    setupNim(() => Promise.reject(new Error("down")));

    const res = createMockResponse();
    await expect(
      matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal),
    ).rejects.toThrow("down");
    expect(eventsOf(res).some((e) => e.status === "complete")).toBe(false);
  });

  it("merges the system message into the user message for system-role-hostile models", async () => {
    let call = 0;
    const create = setupNim((...args: any[]) => {
      call++;
      if (call === 1) {
        const err = new Error("400 - 'system role not supported'") as Error & { status?: number };
        err.status = 400;
        return Promise.reject(err);
      }
      return Promise.resolve(asyncIterable([chunk(GOOD)]));
    });

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal);

    expect(create.mock.calls.length).toBe(2);
    const retriedMessages = (create.mock.calls[1][0] as any).messages;
    expect(retriedMessages).toHaveLength(1);
    expect(retriedMessages[0].role).toBe("user");
    expect(retriedMessages[0].content).toContain("expert technical recruiter");
    expect(retriedMessages[0].content).toContain(job.title);
    expect(eventsOf(res).some((e) => e.status === "complete")).toBe(true);
  });

  it("passes stream_options but retries without them on a plain 400", async () => {
    const create = setupNim((...args: any[]) => {
      if ((args[0] as any).stream_options && create.mock.calls.length === 1) {
        const err = new Error("Unknown field: stream_options") as Error & { status?: number };
        err.status = 400;
        return Promise.reject(err);
      }
      return Promise.resolve(asyncIterable([chunk(GOOD)]));
    });

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, new AbortController().signal);

    expect(create.mock.calls.length).toBe(2);
    expect((create.mock.calls[0][0] as any).stream_options).toBeDefined();
    expect((create.mock.calls[1][0] as any).stream_options).toBeUndefined();
    expect(eventsOf(res).some((e) => e.status === "complete")).toBe(true);
  });

  it("exits silently when the client aborts mid-stream", async () => {
    const controller = new AbortController();

    const abortMidway = async function* () {
      yield chunk('{"matchScore":85,');
      controller.abort();
      yield chunk('"strengths":["x"]}');
    };
    setupNim(() => Promise.resolve(abortMidway()));

    const res = createMockResponse();
    await matchService.streamMatchAnalysis("https://x/resume.pdf", job, res, controller.signal);

    const evts = eventsOf(res);
    expect(evts.some((e) => e.status === "complete")).toBe(false);
    expect(evts.some((e) => e.status === "error")).toBe(false);
  });
});
