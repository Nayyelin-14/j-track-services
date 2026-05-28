import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

const mockSql = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSetEx = vi.fn();
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
vi.mock("../../index", () => ({
  redisClient: { get: mockRedisGet, setEx: mockRedisSetEx },
}));

const MODULES = await import("../user.controller");

function mockReq(overrides: Record<string, unknown> = {}) {
  return { body: {}, params: {}, file: undefined, on: vi.fn(), ...overrides } as any;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((d: unknown) => d);
  return res as import("express").Response;
}

describe("getMe", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 401 without user", async () => {
    const res = mockRes();
    await MODULES.getMe(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/unauthorized/i) });
  });
  it("returns user with skills", async () => {
    mockSql.mockResolvedValueOnce([{ user_id: 1, name: "A", role: "jobseeker", skills: [{ skill_id: 1, name: "TS" }] }]);
    const res = mockRes();
    await MODULES.getMe(mockReq({ user: { user_id: 1 } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, user: expect.any(Object) });
  });
});

describe("getUserById", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 400 for invalid id", async () => {
    const res = mockRes();
    await MODULES.getUserById(mockReq({ params: { id: "abc" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/invalid user id/i) });
  });
  it("returns cached user", async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify({ user_id: 1, name: "A" }));
    const res = mockRes();
    await MODULES.getUserById(mockReq({ params: { id: "1" } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, user: expect.any(Object) });
  });
  it("fetches and caches user from db", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockSql.mockResolvedValueOnce([{ user_id: 1, name: "A", role: "jobseeker", skills: [] }]);
    const res = mockRes();
    await MODULES.getUserById(mockReq({ params: { id: "1" } }), res);
    expect(mockRedisSetEx).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, user: expect.any(Object) });
  });
});

describe("updateUser", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 401 without user", async () => {
    const res = mockRes();
    await MODULES.updateUser(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/unauthorized/i) });
  });
  it("throws 400 if nothing to update", async () => {
    const res = mockRes();
    await MODULES.updateUser(mockReq({ user: { user_id: 1 }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/nothing to update/i) });
  });
  it("validates name length", async () => {
    const res = mockRes();
    await MODULES.updateUser(mockReq({ user: { user_id: 1 }, body: { name: "X" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/name must be at least/i) });
  });
  it("validates phone format", async () => {
    const res = mockRes();
    await MODULES.updateUser(mockReq({ user: { user_id: 1 }, body: { phone_number: "bad" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/invalid phone/i) });
  });
  it("updates successfully", async () => {
    mockSql.mockResolvedValueOnce([{ user_id: 1 }]);
    mockSql.mockResolvedValueOnce([{ user_id: 1, name: "A", email: "a@b.com", role: "recruiter", phone_number: "+123", bio: null, profile_pic: null, created_at: new Date() }]);
    const res = mockRes();
    await MODULES.updateUser(mockReq({ user: { user_id: 1 }, body: { name: "Alice" } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: "Profile updated", user: expect.any(Object) });
  });
});

describe("updateBio", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 400 if bio missing", async () => {
    const res = mockRes();
    await MODULES.updateBio(mockReq({ user: { user_id: 1 }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("throws 400 if bio too long", async () => {
    const res = mockRes();
    await MODULES.updateBio(mockReq({ user: { user_id: 1 }, body: { bio: "x".repeat(2001) } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("updates bio", async () => {
    mockSql.mockResolvedValueOnce([{ user_id: 1 }]);
    mockSql.mockResolvedValueOnce([{ user_id: 1, bio: "Hello" }]);
    const res = mockRes();
    await MODULES.updateBio(mockReq({ user: { user_id: 1 }, body: { bio: "Hello" } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: "Bio updated", user: expect.any(Object) });
  });
});

describe("addSkills", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 400 if skills not an array", async () => {
    const res = mockRes();
    await MODULES.addSkills(mockReq({ user: { user_id: 1 }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/skills array/i) });
  });
  it("throws 400 if empty array", async () => {
    const res = mockRes();
    await MODULES.addSkills(mockReq({ user: { user_id: 1 }, body: { skills: [] } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("adds skills successfully", async () => {
    mockSql.mockResolvedValueOnce([{ user_id: 1 }]);
    mockSql.mockResolvedValueOnce([{ skill_id: 1 }]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ skill_id: 1, name: "ts" }]);
    const res = mockRes();
    await MODULES.addSkills(mockReq({ user: { user_id: 1 }, body: { skills: ["TS"] } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: "Skills added", skills: expect.any(Array) });
  });
});

describe("removeSkills", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("throws 400 if skill_ids missing", async () => {
    const res = mockRes();
    await MODULES.removeSkills(mockReq({ user: { user_id: 1 }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("removes and returns remaining", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ skill_id: 2, name: "js" }]);
    const res = mockRes();
    await MODULES.removeSkills(mockReq({ user: { user_id: 1 }, body: { skill_ids: [1] } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: "Skills removed", skills: expect.any(Array) });
  });
});

describe("getAllSkills", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("returns all skills", async () => {
    mockSql.mockResolvedValueOnce([{ skill_id: 1, name: "ts" }, { skill_id: 2, name: "js" }]);
    const res = mockRes();
    await MODULES.getAllSkills(mockReq(), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, skills: expect.any(Array) });
  });
});
