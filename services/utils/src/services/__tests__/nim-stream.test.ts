import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runNimStream,
  StreamStalledError,
  EmptyResponseError,
  mergeMessagesForSystemRoleHostileModels,
} from "../nim-stream";
import AIConfig from "../../config/ai";

vi.mock("../../config/ai", () => ({
  default: {
    getInstance: vi.fn(),
    getFallbackModel: vi.fn(() => "meta/llama-3.1-8b-instruct"),
    getBaseUrl: vi.fn(() => "https://integrate.api.nvidia.com/v1"),
  },
}));

type Chunk = Record<string, unknown>;

function contentChunk(text: string): Chunk {
  return { choices: [{ delta: { content: text } }] };
}

function reasoningChunk(text: string, field: "reasoning" | "reasoning_content" = "reasoning"): Chunk {
  return { choices: [{ delta: { [field]: text } }] };
}

function usageChunk(): Chunk {
  return { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
}

/** Build a mock async-iterable stream. A `stall` marker waits forever until
 * the request signal aborts (simulating an upstream that stops sending). */
function streamOf(items: Array<Chunk | "stall">, signal?: AbortSignal): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<Chunk>> {
          const item = items[i++];
          if (item === undefined) return Promise.resolve({ done: true, value: undefined as never });
          if (item === "stall") {
            return new Promise((_, reject) => {
              const t = setTimeout(() => reject(new Error("upstream never finished")), 600_000);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(new Error("This operation was aborted"));
                },
                { once: true },
              );
            }) as never;
          }
          return Promise.resolve({ done: false, value: item });
        },
      };
    },
  } as AsyncIterable<Chunk>;
}

function setupCreate(impl: (...args: any[]) => Promise<unknown>) {
  const create = vi.fn(impl);
  (AIConfig.getInstance as ReturnType<typeof vi.fn>).mockReturnValue({ chat: { completions: { create } } });
  return create;
}

beforeEach(() => {
  (AIConfig.getInstance as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runNimStream — user-facing output", () => {
  it("streams delta.content and returns the aggregated text", async () => {
    setupCreate(() => Promise.resolve(streamOf([contentChunk("Hello"), contentChunk(" world"), usageChunk()])));
    const seen: string[] = [];
    const out = await runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, (t) => seen.push(t));
    expect(seen).toEqual(["Hello", " world"]);
    expect(out.text).toBe("Hello world");
    expect(out.usage.total_tokens).toBe(7);
  });

  it("never emits reasoning deltas to onText", async () => {
    setupCreate(() =>
      Promise.resolve(streamOf([reasoningChunk("secret plan"), contentChunk("Answer"), reasoningChunk("more thinking")])),
    );
    const seen: string[] = [];
    const out = await runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, (t) => seen.push(t));
    expect(seen).toEqual(["Answer"]);
    expect(out.text).toBe("Answer");
  });

  it("captures reasoning_content field silently too", async () => {
    setupCreate(() => Promise.resolve(streamOf([reasoningChunk("hidden", "reasoning_content"), contentChunk("Visible")])));
    const seen: string[] = [];
    const out = await runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, (t) => seen.push(t));
    expect(seen).toEqual(["Visible"]);
    expect(out.text).toBe("Visible");
  });

  it("throws EmptyResponseError for reasoning-only output without emitting anything", async () => {
    setupCreate(() => Promise.resolve(streamOf([reasoningChunk("thinking..."), reasoningChunk("still thinking")])));
    const seen: string[] = [];
    await expect(
      runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, (t) => seen.push(t)),
    ).rejects.toBeInstanceOf(EmptyResponseError);
    expect(seen).toEqual([]);
  });

  it("throws EmptyResponseError for a completely empty stream", async () => {
    setupCreate(() => Promise.resolve(streamOf([])));
    await expect(
      runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, () => {}),
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });
});

describe("runNimStream — idle watchdog", () => {
  it("aborts and classifies a stalled stream after the idle window", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const create = setupCreate((_opts: unknown, cfg?: { signal?: AbortSignal }) =>
      Promise.resolve(streamOf([contentChunk("start"), "stall"], cfg?.signal)),
    );

    const pending = runNimStream("m", [{ role: "user", content: "hi" }], ctrl.signal, () => {}, {
      idleTimeoutMs: 30_000,
    });
    void pending.catch(() => {}); // pre-handle: rejection lands across an await boundary

    // One long advance: whichever moment the last chunk re-armed the
    // watchdog during this window, 31+s of idle elapses and it must fire.
    await vi.advanceTimersByTimeAsync(65_000);

    await expect(pending).rejects.toBeInstanceOf(StreamStalledError);
    expect(create).toHaveBeenCalledTimes(1); // no hidden retries
  });

  it("resets the watchdog on every chunk so slow-but-alive streams survive", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();

    // Chunks spaced 20s apart (< 30s idle) for 100s total — must complete.
    const items: Array<Chunk | "stall"> = [];
    for (let i = 0; i < 5; i++) items.push(contentChunk(`p${i}`));

    const create = setupCreate(() =>
      Promise.resolve({
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i > 0) await new Promise((r) => setTimeout(r, 20_000));
              const item = items[i++];
              return item === undefined ? { done: true, value: undefined as never } : { done: false, value: item };
            },
          };
        },
      } as AsyncIterable<Chunk>),
    );

    const pending = runNimStream("m", [{ role: "user", content: "hi" }], ctrl.signal, () => {}, {
      idleTimeoutMs: 30_000,
      deadlineMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const out = await pending;

    expect(out.text).toBe("p0p1p2p3p4");
    void create;
  });

  it("leaves no timers behind after completion or abort", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const okStream = streamOf([contentChunk("done")]);
    setupCreate(() => Promise.resolve(okStream));
    await runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, () => {});

    const armCalls = spy.mock.calls.filter(([, ms]) => ms === 30_000);
    expect(armCalls.length).toBeGreaterThan(0);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    spy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("propagates caller aborts without misclassifying them as stalled", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    setupCreate((_opts: unknown, cfg?: { signal?: AbortSignal }) =>
      Promise.resolve(streamOf([contentChunk("a"), "stall"], cfg?.signal)),
    );

    const pending = runNimStream("m", [{ role: "user", content: "hi" }], ctrl.signal, () => {}, {
      idleTimeoutMs: 30_000,
    });
    void pending.catch(() => {}); // pre-handle: rejection lands across an await boundary
    await Promise.resolve(); // let first chunk flush
    ctrl.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it("never reports success when a client abort ends the stream cleanly with partial content", async () => {
    // Some HTTP stacks terminate the body iterator with `done` instead of a
    // throw when the request is aborted mid-flight. Partial output must not
    // be mistaken for a complete answer.
    const ctrl = new AbortController();
    setupCreate(() =>
      Promise.resolve({
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<Chunk>> =>
              ctrl.signal.aborted
                ? Promise.resolve({ done: true, value: undefined as never })
                : Promise.resolve({ done: false, value: contentChunk("partial ") }),
          };
        },
      } as AsyncIterable<Chunk>),
    );
    const pending = runNimStream("m", [{ role: "user", content: "hi" }], ctrl.signal, () => {});
    void pending.catch(() => {}); // pre-handle: rejection lands across an await boundary
    await Promise.resolve(); // let at least one chunk flush
    ctrl.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});

describe("runNimStream — retry behavior regression", () => {
  it("retries plain once when stream_options is rejected with 400", async () => {
    const create = setupCreate((...args: any[]) => {
      const [opts] = args;
      if ((opts as { stream_options?: unknown }).stream_options) {
        throw Object.assign(new Error("bad request"), { status: 400 });
      }
      return Promise.resolve(streamOf([contentChunk("ok")]));
    });

    const out = await runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, () => {});
    expect(out.text).toBe("ok");
    const secondCall = create.mock.calls[1][0] as { stream_options?: unknown };
    expect(secondCall.stream_options).toBeUndefined();
  });

  it("merges messages with labeled sections when system role is unsupported", async () => {
    const create = setupCreate((...args: any[]) => {
      const [opts] = args;
      if ((opts as { messages: unknown[] }).messages.length > 1) {
        throw Object.assign(new Error("system role not supported"), { status: 400 });
      }
      return Promise.resolve(streamOf([contentChunk("ok")]));
    });

    await runNimStream(
      "m",
      [
        { role: "system", content: "be good" },
        { role: "user", content: "hello" },
      ],
      new AbortController().signal,
      () => {},
    );

    const retried = (create.mock.calls[1][0] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(retried).toHaveLength(1);
    expect(retried[0].role).toBe("user");
    expect(retried[0].content).toContain("=== SYSTEM INSTRUCTIONS ===");
    expect(retried[0].content).toContain("=== USER MESSAGE ===");
  });

  it("surfaces other errors untouched for the caller's chain walk", async () => {
    setupCreate(() => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    await expect(
      runNimStream("m", [{ role: "user", content: "hi" }], new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("mergeMessagesForSystemRoleHostileModels", () => {
  it("labels every role section in order", () => {
    const merged = mergeMessagesForSystemRoleHostileModels([
      { role: "system", content: "SYS" },
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "U2" },
    ]);
    expect(merged).toHaveLength(1);
    const c = merged[0]!.content;
    expect(c.indexOf("=== SYSTEM INSTRUCTIONS ===")).toBeLessThan(c.indexOf("=== USER MESSAGE ==="));
    expect(c.indexOf("=== USER MESSAGE ===")).toBeLessThan(c.indexOf("=== ASSISTANT MESSAGE ==="));
    expect(c).toContain("U2");
  });
});
