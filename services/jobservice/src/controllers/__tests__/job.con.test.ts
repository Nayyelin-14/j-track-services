import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

const mockSqlQuery = vi.fn();
const mockSql = Object.assign(vi.fn(), { query: mockSqlQuery });
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisKeys = vi.fn();
const mockRedisSetEx = vi.fn();
const mockKafkaPublish = vi.fn(() => Promise.resolve());
const mockGetBuffer = vi.fn((f: any) => ({ content: f?.buffer ?? "datauri" }));

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
vi.mock("@jtrack/shared/buffer", () => ({ getBuffer: mockGetBuffer }));
vi.mock("../../redis", () => ({
  redisClient: {
    get: mockRedisGet,
    del: mockRedisDel,
    keys: mockRedisKeys,
    setEx: mockRedisSetEx,
  },
}));
vi.mock("../../kafka", () => ({ kafka: { publish: mockKafkaPublish } }));
vi.mock("../../utils/template", () => ({
  applicationStatusTemplate: vi.fn(() => "<html>"),
}));

process.env.UTILS_SERVICE_URL = "http://utils:6001/api/utils";

const MODULES = await import("../index");

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    file: undefined,
    on: vi.fn(),
    ...overrides,
  } as any;
}
function mockRes() {
  const res: any = { statusCode: 0 };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((d: unknown) => d);
  return res as import("express").Response;
}
function mockNext() {
  return vi.fn();
}

describe("createCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 401 without user", async () => {
    const next = mockNext();
    await MODULES.createCompany(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
  it("throws 403 if not recruiter", async () => {
    const next = mockNext();
    await MODULES.createCompany(
      mockReq({ user: { role: "jobseeker" } }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
  it("creates company without logo file", async () => {
    mockSql.mockResolvedValueOnce([]); // no duplicate
    mockSql.mockResolvedValueOnce([{ company_id: 1 }]);
    const next = mockNext();
    const res = mockRes();
    await MODULES.createCompany(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        body: { name: "Acme", description: "Test", website: "https://acme.com" },
      }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("getAllCompanies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns companies list", async () => {
    mockSql.mockResolvedValueOnce([{ company_id: 1, name: "Acme" }]);
    const res = mockRes();
    await MODULES.getAllCompanies(mockReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1 }),
    );
  });
});

describe("getCompanyById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 404 if not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const next = mockNext();
    const res = mockRes();
    await MODULES.getCompanyById(
      mockReq({ params: { company_id: "999" } }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringMatching(/not found/i) }),
    );
  });
  it("returns company", async () => {
    mockSql.mockResolvedValueOnce([{ company_id: 1, name: "Acme" }]);
    const res = mockRes();
    await MODULES.getCompanyById(
      mockReq({ params: { company_id: "1" } }),
      res,
      () => {},
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});

describe("createJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 401 without user", async () => {
    const next = mockNext();
    await MODULES.createJob(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
  it("throws 403 if not recruiter", async () => {
    const next = mockNext();
    await MODULES.createJob(
      mockReq({ user: { role: "jobseeker" } }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});

describe("applyJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 403 without user", async () => {
    const next = mockNext();
    await MODULES.applyJob(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
  it("throws 403 if not jobseeker", async () => {
    const next = mockNext();
    await MODULES.applyJob(
      mockReq({ user: { role: "recruiter" } }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
  it("applies successfully", async () => {
    mockSql.mockResolvedValueOnce([{ email: "a@b.com" }]);
    mockSql.mockResolvedValueOnce([{ is_active: true }]);
    mockSql.mockResolvedValueOnce([
      { application_id: 1, job_id: 1, applicant_id: 1, status: "Submitted" },
    ]);
    const next = mockNext();
    const res = mockRes();
    await MODULES.applyJob(
      mockReq({
        user: {
          role: "jobseeker",
          user_id: 1,
          resume: "https://res.cloudinary.com/r.pdf",
        },
        body: { jobId: 1 },
      }),
      res,
      next,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: "Application submitted successfully",
      }),
    );
  });
});

describe("getApplications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 401 without user", async () => {
    const next = mockNext();
    await MODULES.getApplications(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
  it("returns applications for jobseeker", async () => {
    mockSql.mockResolvedValueOnce([{ application_id: 1, status: "Submitted" }]);
    const res = mockRes();
    await MODULES.getApplications(
      mockReq({ user: { role: "jobseeker", user_id: 1 } }),
      res,
      () => {},
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});

describe("getAllActiveJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns cached jobs", async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify([{ job_id: 1 }]));
    const res = mockRes();
    await MODULES.getAllActiveJobs(mockReq({ query: {} }), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ fromCache: true }),
    );
  });
  it("fetches and caches jobs from db", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockSqlQuery.mockResolvedValueOnce([[{ job_id: 1 }]]);
    const res = mockRes();
    await MODULES.getAllActiveJobs(mockReq({ query: {} }), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ fromCache: false }),
    );
  });
});

describe("updateJobApplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 401 without user", async () => {
    const next = mockNext();
    await MODULES.updateJobApplication(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
  it("throws 403 if not recruiter", async () => {
    const next = mockNext();
    await MODULES.updateJobApplication(
      mockReq({ user: { role: "jobseeker" } }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
