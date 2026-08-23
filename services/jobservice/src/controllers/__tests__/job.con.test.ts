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
const mockJobUpdate = vi.fn();
const mockApplicationCreate = vi.fn();
const mockApplicationFindMany = vi.fn();
const mockOutboxEventCreate = vi.fn();
const mockUserFindFirst = vi.fn();
const mockPrisma = {
  company: { findFirst: mockCompanyFindFirst, create: mockCompanyCreate, findMany: mockCompanyFindMany, count: mockCompanyCount },
  job: { findFirst: mockJobFindFirst, findMany: mockJobFindMany, count: mockJobCount, create: mockJobCreate, update: mockJobUpdate },
  application: { create: mockApplicationCreate, findMany: mockApplicationFindMany },
  outboxEvent: { create: mockOutboxEventCreate },
  user: { findFirst: mockUserFindFirst },
  $transaction: (fn: (tx: any) => Promise<unknown>) => fn(mockPrisma),
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

  // Regression tests for the salary-range truncation bug:
  // "1000-2000" used to be silently truncated to 1000 by parseFloat.
  it("stores a salary range exactly as provided", async () => {
    mockCompanyFindFirst.mockResolvedValueOnce({ company_id: 1, recruiter_id: 1 });
    mockJobCreate.mockImplementationOnce(async ({ data }: any) => ({ job_id: 1, ...data }));
    const next = mockNext();
    const res = mockRes();
    await MODULES.createJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        body: {
          title: "Engineer",
          description: "Test",
          role: "Dev",
          location: "Remote",
          job_type: "Full-time",
          work_location: "Remote",
          openings: 1,
          company_id: 1,
          salary: "1000-2000",
        },
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockJobCreate.mock.calls[0][0].data.salary).toBe("1000-2000");
    expect((res.json as any).mock.calls[0][0].job.salary).toBe("1000-2000");
  });
  it("normalizes numeric salary input to its string form", async () => {
    mockCompanyFindFirst.mockResolvedValueOnce({ company_id: 1, recruiter_id: 1 });
    mockJobCreate.mockImplementationOnce(async ({ data }: any) => ({ job_id: 1, ...data }));
    const next = mockNext();
    await MODULES.createJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        body: {
          title: "Engineer",
          description: "Test",
          role: "Dev",
          location: "Remote",
          job_type: "Full-time",
          work_location: "Remote",
          openings: 1,
          company_id: 1,
          salary: 150000,
        },
      }),
      mockRes(),
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(mockJobCreate.mock.calls[0][0].data.salary).toBe("150000");
  });
  it("rejects an inverted salary range with 400", async () => {
    mockCompanyFindFirst.mockResolvedValueOnce({ company_id: 1, recruiter_id: 1 });
    const next = mockNext();
    await MODULES.createJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        body: {
          title: "Engineer",
          description: "Test",
          role: "Dev",
          location: "Remote",
          job_type: "Full-time",
          work_location: "Remote",
          openings: 1,
          company_id: 1,
          salary: "2000-1000",
        },
      }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });
  it("rejects a non-numeric salary with 400 instead of truncating it", async () => {
    mockCompanyFindFirst.mockResolvedValueOnce({ company_id: 1, recruiter_id: 1 });
    const next = mockNext();
    await MODULES.createJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        body: {
          title: "Engineer",
          description: "Test",
          role: "Dev",
          location: "Remote",
          job_type: "Full-time",
          work_location: "Remote",
          openings: 1,
          company_id: 1,
          salary: "12ab-30",
        },
      }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });
});

describe("updateJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("persists a range salary on update", async () => {
    mockJobFindFirst.mockResolvedValueOnce({ job_id: 1, company: { company_id: 1, recruiter_id: 1 } });
    mockJobUpdate.mockImplementationOnce(async ({ data }: any) => ({ job_id: 1, ...data }));
    const next = mockNext();
    const res = mockRes();
    await MODULES.updateJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        params: { job_id: "1" },
        body: { salary: "1000-2000" },
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockJobUpdate.mock.calls[0][0].data.salary).toBe("1000-2000");
  });
  it("clears the salary when set to null", async () => {
    mockJobFindFirst.mockResolvedValueOnce({ job_id: 1, company: { company_id: 1, recruiter_id: 1 } });
    mockJobUpdate.mockImplementationOnce(async ({ data }: any) => ({ job_id: 1, ...data }));
    const next = mockNext();
    await MODULES.updateJob(
      mockReq({
        user: { role: "recruiter", user_id: 1 },
        params: { job_id: "1" },
        body: { salary: null },
      }),
      mockRes(),
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(mockJobUpdate.mock.calls[0][0].data.salary).toBeNull();
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
  it("throws 400 if jobseeker has no resume", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ email: "a@b.com", resume: null });
    const next = mockNext();
    await MODULES.applyJob(
      mockReq({
        user: { role: "jobseeker", user_id: 1 },
        body: { jobId: 1 },
      }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
  it("applies successfully", async () => {
    mockUserFindFirst.mockResolvedValueOnce({
      email: "a@b.com",
      resume: "https://res.cloudinary.com/r.pdf",
    });
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
    expect(mockOutboxEventCreate).toHaveBeenCalledOnce();
    expect(mockOutboxEventCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        eventType: "job.applied",
        topic: "job-events",
        partitionKey: "job-1",
        source: "job-service",
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
  it("filters by job_type and work_location from comma-separated and repeated params", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockRedisGet.mockResolvedValueOnce(null);
    mockJobCount.mockResolvedValueOnce(1);
    mockJobFindMany.mockResolvedValueOnce([{ job_id: 1, title: "Engineer", description: "Test", salary: null, location: null, job_type: "Full_time", role: "Dev", work_location: "Remote", openings: 1, created_at: new Date(), company: { company_id: 1, name: "Acme", logo: null } }]);
    const res = mockRes();
    await MODULES.getAllActiveJobs(
      mockReq({ query: { job_type: "Full-time, Part-time", work_location: ["Remote", "Hybrid"] } }),
      res,
    );
    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job_type: { in: ["Full_time", "Part_time"] },
          work_location: { in: ["Remote", "Hybrid"] },
        }),
      }),
    );
    expect(mockJobCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job_type: { in: ["Full_time", "Part_time"] },
          work_location: { in: ["Remote", "Hybrid"] },
        }),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, total: 1 }),
    );
  });
  it("throws 400 for invalid job_type filter", async () => {
    const res = mockRes();
    await MODULES.getAllActiveJobs(
      mockReq({ query: { job_type: "Freelance" } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.any(String) });
  });
  it("throws 400 for invalid work_location filter", async () => {
    const res = mockRes();
    await MODULES.getAllActiveJobs(
      mockReq({ query: { work_location: "Mars" } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.any(String) });
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
