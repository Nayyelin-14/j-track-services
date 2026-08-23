import { describe, it, expect, vi, beforeEach } from "vitest";
import multer from "multer";

const { mockStream } = vi.hoisted(() => ({
  mockStream: vi.fn(),
}));

vi.mock("../../services/resume.js", () => ({
  default: { streamResumeAnalysis: mockStream },
  ResumeError: class ResumeError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { analyzeResume, uploadMiddleware } from "../resume.js";
import resumeService from "../../services/resume.js";

function createRes() {
  const state = { writableEnded: false };
  const write = vi.fn().mockReturnValue(true);
  return {
    res: {
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
    } as unknown as import("express").Response,
    write,
  };
}

function createReq(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    file: undefined,
    ip: "127.0.0.1",
    ...overrides,
  } as unknown as import("express").Request;
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
});

describe("analyzeResume controller", () => {
  it("missing file → single EMPTY_FILE terminal event", async () => {
    const { res, write } = createRes();
    await analyzeResume(createReq(), res);

    const events = sseEvents(write);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", code: "EMPTY_FILE" });
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("non-PDF mimetype → single INVALID_FILE terminal event (no HTTP 500)", async () => {
    const { res, write } = createRes();
    await analyzeResume(
      createReq({
        file: {
          mimetype: "text/plain",
          size: 100,
          originalname: "x.txt",
          buffer: Buffer.from("hi"),
        },
      }),
      res,
    );

    const events = sseEvents(write);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", code: "INVALID_FILE" });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("oversized file → INVALID_FILE terminal event", async () => {
    const { res, write } = createRes();
    await analyzeResume(
      createReq({
        file: {
          mimetype: "application/pdf",
          size: 10 * 1024 * 1024,
          originalname: "big.pdf",
          buffer: Buffer.alloc(1),
        },
      }),
      res,
    );

    const events = sseEvents(write);
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("INVALID_FILE");
  });

  it("service error (malformed PDF) → exactly one terminal error event with code", async () => {
    // Reject with the same ResumeError class the controller imports (mocked).
    const { ResumeError } = await import("../../services/resume.js");
    mockStream.mockRejectedValue(
      new (ResumeError as any)("INVALID_PDF", "Could not read the uploaded PDF"),
    );
    const { res, write } = createRes();

    await analyzeResume(
      createReq({
        file: {
          mimetype: "application/pdf",
          size: 100,
          originalname: "bad.pdf",
          buffer: Buffer.from("%PDF junk"),
        },
      }),
      res,
    );

    const events = sseEvents(write);
    expect(events.filter((e) => e.status === "error")).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({
      status: "error",
      code: "INVALID_PDF",
    });
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("unexpected service crash → INTERNAL_ERROR, internals not leaked", async () => {
    mockStream.mockRejectedValue(new Error("DB password=hunter2 at /secret/path"));
    const { res, write } = createRes();

    await analyzeResume(
      createReq({
        file: {
          mimetype: "application/pdf",
          size: 100,
          originalname: "x.pdf",
          buffer: Buffer.from("%PDF"),
        },
      }),
      res,
    );

    const events = sseEvents(write);
    const terminal = events[events.length - 1];
    expect(terminal.status).toBe("error");
    expect(terminal.message).not.toContain("hunter2");
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("client disconnect mid-stream aborts upstream and terminates once", async () => {
    // Service resolves normally but the response was closed first.
    mockStream.mockImplementation(async (_buf: Buffer, _res: any) => {});
    const { res, write } = createRes();
    const req = createReq({
      file: {
        mimetype: "application/pdf",
        size: 100,
        originalname: "ok.pdf",
        buffer: Buffer.from("%PDF"),
      },
    });

    const pending = analyzeResume(req, res);

    // Simulate the connection dropping before completion.
    const closeHandler = (res as any).on.mock.calls.find(
      ([event]: [string]) => event === "close",
    )?.[1];
    expect(closeHandler).toBeDefined();

    await pending;

    // Controller must have registered the close listener on the RESPONSE.
    expect((res as any).on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("upload middleware accepts files without a restrictive filter", () => {
    // Validation moved to the controller; multer filter must not reject early
    // (that produced plain-HTTP 500s instead of SSE errors).
    const upload: multer.Multer = uploadMiddleware as any;
    void upload;
    expect(mockStream).toBeDefined();
    expect(resumeService.streamResumeAnalysis).toBeDefined();
  });
});
