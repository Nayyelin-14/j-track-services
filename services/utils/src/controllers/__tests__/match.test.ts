import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeMatch } from "../match";
import matchService from "../../services/match";

vi.mock("../../services/match", () => ({
  default: {
    streamMatchAnalysis: vi.fn(),
  },
}));

function createMockReq(body: unknown) {
  return {
    body,
    on: vi.fn(),
  } as unknown as import("express").Request;
}

let writableEnded = false;

function createMockRes() {
  writableEnded = false;
  const write = vi.fn().mockReturnValue(true);
  const end = vi.fn().mockImplementation(() => { writableEnded = true; });

  return {
    write,
    end,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    get writableEnded() { return writableEnded; },
    on: vi.fn(),
  } as unknown as import("express").Response;
}

describe("analyzeMatch controller", () => {
  let res: ReturnType<typeof createMockRes>;
  let streamMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    res = createMockRes();
    streamMock = vi.mocked(matchService.streamMatchAnalysis);
  });

  it("sets SSE headers and calls service with parsed input", async () => {
    streamMock.mockResolvedValue(undefined);

    const req = createMockReq({
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: {
        title: "Software Engineer",
        description: "Build cool stuff",
      },
    });

    await analyzeMatch(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(res.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    expect(res.flushHeaders).toHaveBeenCalledOnce();

    expect(streamMock).toHaveBeenCalledOnce();
    const [resumeUrl, job, resArg] = streamMock.mock.calls[0];

    expect(resumeUrl).toBe("https://res.cloudinary.com/demo/resume.pdf");
    expect(job).toMatchObject({
      title: "Software Engineer",
      description: "Build cool stuff",
    });
    expect(resArg).toBe(res);
  });

  it("writes validation error SSE when request body is invalid", async () => {
    const req = createMockReq({
      resumeUrl: "not-a-url",
      job: { title: "Engineer" },
    });

    await analyzeMatch(req, res);

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);

    const errorEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(errorEvent.status).toBe("error");
    expect(errorEvent.message).toBe("Validation failed");
    expect(errorEvent.errors).toBeDefined();
    expect(Array.isArray(errorEvent.errors)).toBe(true);
    expect(errorEvent.errors.some((e: string) => e.includes("resumeUrl"))).toBe(true);
  });

  it("writes validation error when job description is missing", async () => {
    const req = createMockReq({
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: { title: "Engineer" },
    });

    await analyzeMatch(req, res);

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const errorEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(errorEvent.status).toBe("error");
    expect(errorEvent.message).toBe("Validation failed");
    expect(errorEvent.errors.some((e: string) => e.includes("description"))).toBe(true);
  });

  it("writes generic error SSE when service throws", async () => {
    streamMock.mockRejectedValue(new Error("Groq API connection failed"));

    const req = createMockReq({
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: {
        title: "Engineer",
        description: "A great job",
      },
    });

    await analyzeMatch(req, res);

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const errorEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(errorEvent.status).toBe("error");
    expect(errorEvent.message).toBe("Groq API connection failed");
  });

  it("ends the response in the finally block after success", async () => {
    streamMock.mockResolvedValue(undefined);

    const req = createMockReq({
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: {
        title: "Engineer",
        description: "A great job",
      },
    });

    await analyzeMatch(req, res);

    expect(res.end).toHaveBeenCalledOnce();
  });

  it("does not write error twice on validation failure followed by service throw", async () => {
    const req = createMockReq({
      resumeUrl: "not-a-url",
      job: { title: "Engineer" },
    });

    await analyzeMatch(req, res);

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const errorEvents = writeCalls.filter(([data]) => data.includes('"error"'));
    expect(errorEvents).toHaveLength(1);
  });

  it("only calls setSSEHeaders once", async () => {
    streamMock.mockResolvedValue(undefined);

    const req = createMockReq({
      resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
      job: { title: "Engineer", description: "Job" },
    });

    await analyzeMatch(req, res);

    expect(res.setHeader).toHaveBeenCalledTimes(4);
    expect(res.flushHeaders).toHaveBeenCalledOnce();
  });

  it("does not write SSE data when client disconnects before service returns", async () => {
    let closeHandler: () => void;

    const req = {
      body: {
        resumeUrl: "https://res.cloudinary.com/demo/resume.pdf",
        job: { title: "Engineer", description: "Job" },
      },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "close") closeHandler = handler;
        return req;
      }),
    } as unknown as import("express").Request;

    const controller = new AbortController();
    const originalAbort = controller.abort.bind(controller);

    streamMock.mockImplementation(
      async (_url: unknown, _job: unknown, _res: unknown, signal: AbortSignal) => {
        closeHandler();
        if (signal.aborted) {
          originalAbort();
          return;
        }
      },
    );

    await analyzeMatch(req, res);
  });
});
