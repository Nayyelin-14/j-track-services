import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@jtrack/shared/db", () => ({ sql: mockSql }));
vi.mock("@jtrack/shared/errorHandler", () => ({
  ErrorHandler: class extends Error {
    statusCode: number;
    constructor(code: number, msg: string) {
      super(msg);
      this.statusCode = code;
    }
  },
}));

process.env.UTILS_SERVICE_URL = "http://utils:6001/api/utils";

const MODULES = await import("../match.con");

function mockReq(overrides: Record<string, unknown> = {}) {
  return { body: {}, params: {}, on: vi.fn(), ...overrides } as any;
}
function mockRes() {
  let ended = false;
  const res: any = { headers: {}, writableEnded: false };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((d: unknown) => d);
  res.setHeader = vi.fn((k: string, v: string) => { res.headers[k] = v; return res; });
  res.flushHeaders = vi.fn();
  res.write = vi.fn();
  res.end = vi.fn(() => { ended = true; });
  Object.defineProperty(res, "writableEnded", { get: () => ended });
  return res as import("express").Response;
}

describe("analyzeJobMatch", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 401 without user", async () => {
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.any(String) });
  });

  it("throws 403 if not jobseeker", async () => {
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq({ user: { role: "recruiter" } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("throws 400 for invalid job id", async () => {
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq({ user: { role: "jobseeker", user_id: 1 }, params: { jobId: "abc" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 404 if user not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq({ user: { role: "jobseeker", user_id: 999 }, params: { jobId: "1" } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("throws 400 if user has no resume", async () => {
    mockSql.mockResolvedValueOnce([{ resume: null }]);
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq({ user: { role: "jobseeker", user_id: 1 }, params: { jobId: "1" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/resume/i) });
  });

  it("throws 404 if job not found", async () => {
    mockSql.mockResolvedValueOnce([{ resume: "https://cloudinary.com/r.pdf" }]);
    mockSql.mockResolvedValueOnce([]);
    const res = mockRes();
    await MODULES.analyzeJobMatch(mockReq({ user: { role: "jobseeker", user_id: 1 }, params: { jobId: "999" } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
