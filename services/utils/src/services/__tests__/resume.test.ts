import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import resumeService, { ResumeError } from "../resume";
import AIConfig from "../../config/ai";

const { mockGetText, mockDestroy, mockNimCreate } = vi.hoisted(() => ({
  mockGetText: vi.fn(),
  mockDestroy: vi.fn(),
  mockNimCreate: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn(function () {
    return { getText: mockGetText, destroy: mockDestroy };
  }),
}));

vi.mock("../../config/ai", () => {
  const mockModel = "nvidia/nemotron";
  return {
    default: {
      getInstance: vi.fn(() => ({
        chat: { completions: { create: mockNimCreate } },
      })),
      getModel: vi.fn(() => mockModel),
    },
  };
});

const LONG_TEXT = "a".repeat(200);

function createMockResponse() {
  const state = { writableEnded: false };
  const write = vi.fn().mockReturnValue(true);
  const res = {
    write,
    get writableEnded() {
      return state.writableEnded;
    },
    end: vi.fn(() => {
      state.writableEnded = true;
    }),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    on: vi.fn(),
  } as unknown as import("express").Response;
  return { res, write };
}

function sseEvents(write: ReturnType<typeof vi.fn>): any[] {
  return write.mock.calls
    .map(([chunk]: [string]) => chunk)
    .join("")
    .split("\n\n")
    .filter((line: string) => line.startsWith("data: "))
    .map((line: string) => JSON.parse(line.slice(6)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDestroy.mockResolvedValue(undefined);
});

describe("extractTextFromPDF", () => {
  it("rejects EMPTY_FILE for zero-byte buffers", async () => {
    await expect(resumeService.extractTextFromPDF(Buffer.alloc(0))).rejects.toMatchObject({
      code: "EMPTY_FILE",
    });
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it("returns text for a valid PDF", async () => {
    mockGetText.mockResolvedValue({ text: LONG_TEXT });
    const text = await resumeService.extractTextFromPDF(Buffer.from("%PDF-1.4 fake"));
    expect(text).toContain(LONG_TEXT.slice(0, 50));
    expect(mockDestroy).toHaveBeenCalled();
  });

  it.each([
    ["malformed", new Error("Invalid PDF structure")],
    ["truncated", Object.assign(new Error("bad"), { name: "InvalidPDFException" })],
    ["generic parser error", new Error("something exploded")],
  ])("maps %s getText failure to INVALID_PDF", async (_name, err) => {
    mockGetText.mockRejectedValue(err);
    await expect(
      resumeService.extractTextFromPDF(Buffer.from("%PDF-1.4 junk")),
    ).rejects.toMatchObject({ code: "INVALID_PDF" });
  });

  it("maps short extracted text to EMPTY_TEXT", async () => {
    mockGetText.mockResolvedValue({ text: "too short" });
    await expect(
      resumeService.extractTextFromPDF(Buffer.from("%PDF-1.4")),
    ).rejects.toMatchObject({ code: "EMPTY_TEXT" });
  });

  it("still settles when parser.destroy() hangs", async () => {
    mockGetText.mockRejectedValue(new Error("Invalid PDF structure"));
    mockDestroy.mockImplementation(() => new Promise(() => {}));
    await expect(
      Promise.race([
        resumeService.extractTextFromPDF(Buffer.from("junk")),
        new Promise((_, rej) => setTimeout(() => rej(new Error("TEST_HANG")), 8000)),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_PDF" });
  });

  it("enforces a hard extraction timeout (PARSE_TIMEOUT)", async () => {
    vi.useFakeTimers();
    mockGetText.mockImplementation(() => new Promise(() => {}));
    try {
      const pending = resumeService.extractTextFromPDF(Buffer.from("%PDF"));
      const assertion = expect(pending).rejects.toMatchObject({ code: "PARSE_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamResumeAnalysis", () => {
  const nimJson = JSON.stringify({ atsScore: {}, summary: "ok" });

  beforeEach(() => {
    mockGetText.mockResolvedValue({ text: LONG_TEXT });
  });

  it("streams extracting → analyzing → done and ends the response", async () => {
    mockNimCreate.mockResolvedValue({ choices: [{ message: { content: nimJson } }] });
    const { res, write } = createMockResponse();

    await resumeService.streamResumeAnalysis(Buffer.from("%PDF"), res);

    const events = sseEvents(write);
    expect(events.map((e) => e.status)).toEqual(["extracting", "analyzing", "done"]);
    expect(events[2].result.summary).toBe("ok");
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("rejects with UPSTREAM_ERROR without leaking internals", async () => {
    mockNimCreate.mockRejectedValue(new Error("secret-nim-internal-detail"));
    const { res, write } = createMockResponse();

    // Terminal SSE emission is the CONTROLLER's job; the service must reject
    // with a typed, sanitized error.
    await expect(
      resumeService.streamResumeAnalysis(Buffer.from("%PDF"), res),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    const serialized = JSON.stringify(sseEvents(write));
    expect(serialized).not.toContain("secret-nim-internal-detail");
    expect(res.end).not.toHaveBeenCalled();
  });

  it("aborts with ABORTED when signal is already aborted after extraction", async () => {
    const controller = new AbortController();
    controller.abort();
    mockNimCreate.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
    const { res } = createMockResponse();

    await expect(
      resumeService.streamResumeAnalysis(Buffer.from("%PDF"), res, controller.signal),
    ).rejects.toMatchObject({ code: "ABORTED" });

    // NIM must never be called once the client is gone.
    expect(mockNimCreate).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("passes abort signal through to NIM create", async () => {
    mockNimCreate.mockResolvedValue({ choices: [{ message: { content: nimJson } }] });
    const { res } = createMockResponse();
    const controller = new AbortController();

    await resumeService.streamResumeAnalysis(Buffer.from("%PDF"), res, controller.signal);

    const [_body, options] = mockNimCreate.mock.calls[0];
    expect(options?.signal).toBe(controller.signal);
  });

  it("propagates ResumeError codes from extraction to caller", async () => {
    mockGetText.mockRejectedValue(new ResumeError("INVALID_PDF", "nope"));
    const { res, write } = createMockResponse();

    await expect(
      resumeService.streamResumeAnalysis(Buffer.from("junk"), res),
    ).rejects.toMatchObject({ code: "INVALID_PDF" });

    // Only the initial progress event may have been written; no done event.
    const statuses = sseEvents(write).map((e) => e.status);
    expect(statuses).toEqual(["extracting"]);
    expect(res.end).not.toHaveBeenCalled();
  });
});
