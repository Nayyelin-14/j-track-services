import { describe, it, expect, vi, beforeEach } from "vitest";
import matchService from "../match";
import GroqConfig from "../../config/groq";

const { mockGetText, MockPDFParse } = vi.hoisted(() => {
  const mockGetText = vi.fn().mockResolvedValue({ text: "" });
  return {
    mockGetText,
    MockPDFParse: vi.fn(function () {
      return { getText: mockGetText };
    }),
  };
});

vi.mock("pdf-parse", () => ({
  PDFParse: MockPDFParse,
}));

vi.mock("../../config/groq", () => ({
  default: {
    getInstance: vi.fn(),
    getModel: vi.fn(() => "llama-3.3-70b-versatile"),
  },
}));

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
  for (const item of items) {
    yield item;
  }
}

function groqChunk(text: string) {
  return {
    choices: [
      {
        delta: { content: text, role: "assistant" },
        index: 0,
        finish_reason: null,
      },
    ],
    id: "test",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "llama-3.3-70b-versatile",
  } as const;
}

const validJob = {
  title: "Senior Software Engineer",
  description: "Build and maintain cloud-native microservices.",
  salary: 150000,
  location: "San Francisco, CA",
  job_type: "full-time",
  work_location: "remote",
  role: "Senior Engineer",
  company_name: "Acme Corp",
};

function mockPdfPage(textParts: string[]) {
  mockGetText.mockResolvedValue({
    text: textParts.join(""),
  });
}

function mockFetchResponse(overrides: Partial<{
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string;
  body: string;
}> = {}) {
  const config = {
    ok: true,
    status: 200,
    statusText: "OK",
    contentType: "application/pdf",
    body: "%PDF-1.4\r\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\r\n%%EOF",
    ...overrides,
  };

  const buf = Buffer.from(config.body);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: config.ok,
    status: config.status,
    statusText: config.statusText,
    headers: {
      get: vi.fn((name: string) =>
        name.toLowerCase() === "content-type" ? config.contentType : null
      ),
    },
    arrayBuffer: vi.fn().mockResolvedValue(ab),
  });
}

function setupGroqStream(chunks: string[]) {
  const mockGroq = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue(asyncIterable(chunks.map(groqChunk))),
      },
    },
  };
  vi.mocked(GroqConfig.getInstance).mockReturnValue(mockGroq as never);
  return mockGroq.chat.completions.create;
}

describe("downloadAndParseResume", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads a PDF and extracts text from all pages", async () => {
    mockPdfPage([
      "John Doe",
      "Senior Software Engineer with 8 years of experience",
      "TypeScript, React, Node.js, PostgreSQL, AWS",
    ]);
    mockFetchResponse();
    const signal = new AbortController().signal;

    const text = await matchService.downloadAndParseResume(
      "https://res.cloudinary.com/demo/resume.pdf",
      signal,
    );

    expect(text).toContain("John Doe");
    expect(text).toContain("TypeScript");
    expect(text).toContain("PostgreSQL");
  });

  it("strips non-ASCII characters from extracted text", async () => {
    mockPdfPage([
      "John Doe \u2013 Senior Software Engineer \u2014 Full Stack Developer",
      "Built and maintained cloud-native microservices using TypeScript and Node.js",
      "Led a team of 5 engineers to deliver a high-traffic e-commerce platform",
    ]);
    mockFetchResponse();
    const signal = new AbortController().signal;

    const text = await matchService.downloadAndParseResume(
      "https://res.cloudinary.com/demo/resume.pdf",
      signal,
    );

    expect(text).not.toContain("\u2013");
    expect(text).not.toContain("\u2014");
  });

  it("throws on HTTP error response", async () => {
    mockPdfPage(["Some text"]);
    mockFetchResponse({ ok: false, status: 404, statusText: "Not Found" });
    const signal = new AbortController().signal;

    await expect(
      matchService.downloadAndParseResume(
        "https://res.cloudinary.com/demo/missing.pdf",
        signal,
      ),
    ).rejects.toThrow("Failed to download resume: 404 Not Found");
  });

  it("throws on non-PDF content type", async () => {
    mockFetchResponse({ contentType: "text/html", body: "<html></html>" });
    const signal = new AbortController().signal;

    await expect(
      matchService.downloadAndParseResume(
        "https://res.cloudinary.com/demo/file.html",
        signal,
      ),
    ).rejects.toThrow("Unsupported resume format: text/html");
  });

  it("throws when PDF extracted text is too short", async () => {
    mockPdfPage(["AB"]);
    mockFetchResponse();
    const signal = new AbortController().signal;

    await expect(
      matchService.downloadAndParseResume(
        "https://res.cloudinary.com/demo/short.pdf",
        signal,
      ),
    ).rejects.toThrow("Resume PDF is empty or unreadable");
  });

  it("throws on abort signal", async () => {
    mockFetchResponse();
    const controller = new AbortController();
    controller.abort();

    await expect(
      matchService.downloadAndParseResume(
        "https://res.cloudinary.com/demo/resume.pdf",
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("sets Accept header to prefer PDF", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, opts: { headers: Record<string, string> }) => {
        capturedHeaders = opts.headers as Record<string, string>;

        const buf = Buffer.from("%PDF-1.4");
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: vi.fn(() => "application/pdf") },
          arrayBuffer: vi.fn().mockResolvedValue(ab),
        });
      },
    );

    mockPdfPage(["Text"]);
    const signal = new AbortController().signal;

    await matchService.downloadAndParseResume(
      "https://res.cloudinary.com/demo/resume.pdf",
      signal,
    ).catch(() => {});

    expect(capturedHeaders["Accept"]).toBe("application/pdf,application/octet-stream,*/*");
  });
});

describe("streamMatchAnalysis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(matchService, "downloadAndParseResume").mockResolvedValue(
      "Mocked resume text with skills and cloud experience.",
    );
  });

  it("writes download progress, analyze progress, then complete event", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;
    const create = setupGroqStream([
      `{"matchScore":85,"strengths":["Strong TypeScript skills"],`,
      `"gaps":["No Python"],"recommendation":"yes",`,
      `"recommendationReason":"Strong core alignment",`,
      `"summary":"Good match","fullAnalysis":"Candidate is a strong fit"}`,
    ]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const events = writeCalls.map(([data]: [string]) =>
      JSON.parse(data.replace(/^data: /, "").replace(/\n\n$/, ""))
    );

    expect(events[0].status).toBe("progress");
    expect(events[0].stage).toBe("download");

    expect(events[1].status).toBe("progress");
    expect(events[1].stage).toBe("analyze");

    const complete = events.find((e) => e.status === "complete");
    expect(complete.result.matchScore).toBe(85);
    expect(complete.result.recommendation).toBe("yes");
    expect(complete.result.strengths).toEqual(["Strong TypeScript skills"]);
  });

  it("sends full job context in the AI prompt", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;
    const create = setupGroqStream([
      '{"matchScore":50,"strengths":[],"gaps":[],"recommendation":"maybe",' +
      '"recommendationReason":"","summary":"","fullAnalysis":""}',
    ]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const [[createArgs]] = create.mock.calls as unknown as [[{
      messages: Array<{ content: string }>;
    }]];
    const prompt = createArgs.messages[0].content;

    expect(prompt).toContain("Senior Software Engineer");
    expect(prompt).toContain("Build and maintain cloud-native microservices");
    expect(prompt).toContain("Salary: 150000");
    expect(prompt).toContain("San Francisco, CA");
    expect(prompt).toContain("full-time");
    expect(prompt).toContain("remote");
    expect(prompt).toContain("Senior Engineer");
    expect(prompt).toContain("Acme Corp");
  });

  it("omits null and undefined optional fields from the prompt", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;

    const partialJob = {
      title: "Junior Developer",
      description: "Entry-level position",
      salary: undefined,
      location: undefined,
      job_type: undefined,
      work_location: undefined,
      role: undefined,
      company_name: undefined,
    };

    const create = setupGroqStream([
      '{"matchScore":30,"strengths":[],"gaps":[],"recommendation":"maybe",' +
      '"recommendationReason":"","summary":"","fullAnalysis":""}',
    ]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      partialJob,
      res,
      signal,
    );

    const [[createArgs]] = create.mock.calls as unknown as [[{
      messages: Array<{ content: string }>;
    }]];
    const prompt = createArgs.messages[0].content;

    expect(prompt).toContain("Junior Developer");
    expect(prompt).toContain("Entry-level position");
    expect(prompt).not.toContain("Salary:");
    expect(prompt).not.toContain("Location:");
    expect(prompt).not.toContain("null");
    expect(prompt).not.toContain("undefined");
  });

  it("includes details fields in the AI prompt", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;

    const jobWithDetails = {
      ...validJob,
      details: {
        responsibilities: "Build and maintain microservices",
        required_skills: "5+ years Node.js, TypeScript",
        preferred_skills: "Docker, Kubernetes",
        tech_stack: ["Node.js", "React", "PostgreSQL"],
        experience_years: 5,
        education: "Bachelor's in CS",
        certifications: ["AWS Certified"],
        languages: ["English", "Japanese"],
        benefits: "Health insurance, remote work",
        visa_sponsorship: true,
        working_hours: "9:00 - 18:00",
        team_structure: "5 engineers, 1 PM",
        reporting_line: "Engineering Manager",
        career_growth: "Senior to Staff Engineer",
        interview_process: "Phone screen, tech interview",
      },
    };

    const create = setupGroqStream([
      '{"matchScore":90,"strengths":[],"gaps":[],"recommendation":"yes",' +
      '"recommendationReason":"","summary":"","fullAnalysis":""}',
    ]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      jobWithDetails,
      res,
      signal,
    );

    const [[createArgs]] = create.mock.calls as unknown as [[{
      messages: Array<{ content: string }>;
    }]];
    const prompt = createArgs.messages[0].content;

    expect(prompt).toContain("Responsibilities: Build and maintain microservices");
    expect(prompt).toContain("Required Skills: 5+ years Node.js, TypeScript");
    expect(prompt).toContain("Preferred Skills: Docker, Kubernetes");
    expect(prompt).toContain("Tech Stack: Node.js, React, PostgreSQL");
    expect(prompt).toContain("Experience Required: 5 years");
    expect(prompt).toContain("Education: Bachelor's in CS");
    expect(prompt).toContain("Certifications: AWS Certified");
    expect(prompt).toContain("Languages: English, Japanese");
    expect(prompt).toContain("Benefits: Health insurance, remote work");
    expect(prompt).toContain("Visa Sponsorship: Yes");
    expect(prompt).toContain("Working Hours: 9:00 - 18:00");
    expect(prompt).toContain("Team Structure: 5 engineers, 1 PM");
    expect(prompt).toContain("Reports To: Engineering Manager");
    expect(prompt).toContain("Career Growth: Senior to Staff Engineer");
    expect(prompt).toContain("Interview Process: Phone screen, tech interview");
  });

  it("omits details fields when not provided", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;

    const create = setupGroqStream([
      '{"matchScore":50,"strengths":[],"gaps":[],"recommendation":"maybe",' +
      '"recommendationReason":"","summary":"","fullAnalysis":""}',
    ]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const [[createArgs]] = create.mock.calls as unknown as [[{
      messages: Array<{ content: string }>;
    }]];
    const prompt = createArgs.messages[0].content;

    expect(prompt).not.toContain("Responsibilities:");
    expect(prompt).not.toContain("Required Skills:");
    expect(prompt).not.toContain("Tech Stack:");
  });

  it("returns fallback values when AI returns invalid JSON", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;
    setupGroqStream(["This is not valid JSON at all"]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const lastEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(lastEvent.status).toBe("complete");
    expect(lastEvent.result.matchScore).toBe(0);
    expect(lastEvent.result.strengths).toEqual([]);
    expect(lastEvent.result.recommendation).toBe("maybe");
    expect(lastEvent.result.fullAnalysis).toBe("This is not valid JSON at all");
  });

  it("handles markdown-wrapped JSON from AI", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;
    setupGroqStream(['```json\n{"matchScore":72,"recommendation":"yes"}\n```']);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const lastEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(lastEvent.result.matchScore).toBe(72);
    expect(lastEvent.result.recommendation).toBe("yes");
  });

  it("handles JSON with surrounding whitespace", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;
    setupGroqStream(["\n\n  \n{\"matchScore\":65}\n  \n\n"]);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      signal,
    );

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const lastEvent = JSON.parse(
      writeCalls[writeCalls.length - 1][0]
        .replace(/^data: /, "")
        .replace(/\n\n$/, ""),
    );

    expect(lastEvent.result.matchScore).toBe(65);
  });

  it("throws when AI streaming fails", async () => {
    const res = createMockResponse();
    const signal = new AbortController().signal;

    vi.mocked(GroqConfig.getInstance).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
        },
      },
    } as never);

    await expect(
      matchService.streamMatchAnalysis(
        "https://res.cloudinary.com/demo/resume.pdf",
        validJob,
        res,
        signal,
      ),
    ).rejects.toThrow("API rate limit exceeded");
  });

  it("throws when download fails", async () => {
    vi.spyOn(matchService, "downloadAndParseResume").mockRejectedValue(
      new Error("Failed to download resume: 403 Forbidden"),
    );

    const res = createMockResponse();
    const signal = new AbortController().signal;

    await expect(
      matchService.streamMatchAnalysis(
        "https://res.cloudinary.com/demo/private.pdf",
        validJob,
        res,
        signal,
      ),
    ).rejects.toThrow("403 Forbidden");
  });

  it("returns early when abort signal is received mid-stream", async () => {
    const res = createMockResponse();
    const controller = new AbortController();

    const abortInMiddle = async function* () {
      yield groqChunk('{"matchScore":85,');
      controller.abort();
      yield groqChunk('"strengths":["Test"],');
    };

    vi.mocked(GroqConfig.getInstance).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(abortInMiddle()),
        },
      },
    } as never);

    await matchService.streamMatchAnalysis(
      "https://res.cloudinary.com/demo/resume.pdf",
      validJob,
      res,
      controller.signal,
    );

    const writeCalls = (res.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const events = writeCalls.map(([data]: [string]) =>
      JSON.parse(data.replace(/^data: /, "").replace(/\n\n$/, ""))
    );

    expect(events.some((e) => e.status === "complete")).toBe(false);
    expect(events.some((e) => e.status === "error")).toBe(false);
  });
});
