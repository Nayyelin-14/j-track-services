import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

const mockCompanyFindFirst = vi.fn();
const mockCompanyCreate = vi.fn();
const mockCompanyFindMany = vi.fn();
const mockCompanyCount = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobFindMany = vi.fn();
const mockJobCount = vi.fn();
const mockJobCreate = vi.fn();
const mockApplicationCreate = vi.fn();
const mockApplicationFindMany = vi.fn();
const mockUserFindFirst = vi.fn();
const mockPrisma = {
  company: { findFirst: mockCompanyFindFirst, create: mockCompanyCreate, findMany: mockCompanyFindMany, count: mockCompanyCount },
  job: { findFirst: mockJobFindFirst, findMany: mockJobFindMany, count: mockJobCount, create: mockJobCreate },
  application: { create: mockApplicationCreate, findMany: mockApplicationFindMany },
  user: { findFirst: mockUserFindFirst },
};
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisKeys = vi.fn();
const mockRedisSetEx = vi.fn();
const mockRedisIncr = vi.fn(() => Promise.resolve(1));
const mockKafkaPublish = vi.fn(() => Promise.resolve());
const mockGetBuffer = vi.fn((f: any) => ({ content: f?.buffer ?? "datauri" }));

vi.mock("@jtrack/shared/db", () => ({ prisma: mockPrisma }));
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
    incr: mockRedisIncr,
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
    mockCompanyFindFirst.mockResolvedValueOnce(null);
    mockCompanyCreate.mockResolvedValueOnce({ company_id: 1, name: "Acme", description: "Test", website: "https://acme.com", created_at: new Date() });
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
  it("returns from cache when available", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ companies: [{ company_id: 1, name: "Acme" }], total: 1 }),
    );
    const res = mockRes();
    await MODULES.getAllCompanies(mockReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1, total: 1, page: 1, totalPages: 1, fromCache: true }),
    );
  });
  it("fetches from db on cache miss", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockRedisGet.mockResolvedValueOnce(null);
    mockCompanyFindMany.mockResolvedValueOnce([{ company_id: 1, name: "Acme", description: "Test", website: "https://acme.com", location: null, logo: null, created_at: new Date() }]);
    mockCompanyCount.mockResolvedValueOnce(1);
    const res = mockRes();
    await MODULES.getAllCompanies(mockReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1, total: 1, page: 1, totalPages: 1 }),
    );
  });
});

describe("getCompanyById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("throws 404 if not found", async () => {
    mockCompanyFindFirst.mockResolvedValueOnce(null);
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
    mockCompanyFindFirst.mockResolvedValueOnce({ company_id: 1, name: "Acme", description: "Test", website: "https://acme.com", location: null, logo: null, created_at: new Date() });
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
    mockUserFindFirst.mockResolvedValueOnce({ email: "a@b.com" });
    mockJobFindFirst.mockResolvedValueOnce({ is_active: true });
    mockApplicationCreate.mockResolvedValueOnce(
      { application_id: 1, job_id: 1, applicant_id: 1, status: "Submitted", subscribed: false },
    );
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
    mockApplicationFindMany.mockResolvedValueOnce([{ application_id: 1, status: "Submitted", applied_at: new Date(), subscribed: null, job: { job_id: 1, title: "Engineer", salary: null, location: null, job_type: "Full_time", work_location: "Remote", is_active: true, company: { company_id: 1, name: "Acme", logo: null } } }]);
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
  it("returns from cache when available", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ jobs: [{ job_id: 1, title: "Engineer" }], total: 1 }),
    );
    const res = mockRes();
    await MODULES.getAllActiveJobs(mockReq({ query: {} }), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1, total: 1, page: 1, totalPages: 1, fromCache: true }),
    );
  });
  it("fetches from db on cache miss", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockRedisGet.mockResolvedValueOnce(null);
    mockJobCount.mockResolvedValueOnce(1);
    mockJobFindMany.mockResolvedValueOnce([{ job_id: 1, title: "Engineer", description: "Test", salary: null, location: null, job_type: "Full_time", role: "Dev", work_location: "Remote", openings: 1, created_at: new Date(), company: { company_id: 1, name: "Acme", logo: null } }]);
    const res = mockRes();
    await MODULES.getAllActiveJobs(mockReq({ query: {} }), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1, total: 1, page: 1, totalPages: 1 }),
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
