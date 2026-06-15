import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import axios from "axios";

const mockBcryptCompare = vi.fn();
const mockBcryptHash = vi.fn((p: string) => Promise.resolve(`hashed_${p}`));
const mockUserFindFirst = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockPrisma = {
  user: { findFirst: mockUserFindFirst, create: mockUserCreate, update: mockUserUpdate },
  $queryRaw: vi.fn(),
};
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisSetEx = vi.fn();
const mockRedisDel = vi.fn();
const mockKafkaPublish = vi.fn();
const mockSignAccess = vi.fn(() => "access-token");
const mockSignRefresh = vi.fn(() => "refresh-token");
const mockSignReset = vi.fn(() => "reset-token");
const mockCheckRate = vi.fn();
const mockClearFailed = vi.fn();
const mockClearRate = vi.fn();
const mockDel = vi.fn();
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockTrackFailed = vi.fn();
const mockWithCache = vi.fn(
  async (_client: any, _key: string, _ttl: number, fetch: () => Promise<unknown>) => {
    const data = await fetch();
    return { data, fromCache: false };
  },
);

vi.mock("bcrypt", () => ({
  default: { compare: mockBcryptCompare, hash: mockBcryptHash, genSalt: vi.fn() },
  compare: mockBcryptCompare,
  hash: mockBcryptHash,
  genSalt: vi.fn(),
}));
vi.mock("@jtrack/shared/db", () => ({ prisma: mockPrisma }));
vi.mock("@jtrack/shared/token", () => ({
  signAccessToken: mockSignAccess,
  signRefreshToken: mockSignRefresh,
  signResetToken: mockSignReset,
}));
vi.mock("@jtrack/shared/cookies", () => ({
  accessCookieOptions: { httpOnly: true },
  refreshCookieOptions: { httpOnly: true },
}));
vi.mock("@jtrack/shared/errorHandler", () => ({
  ErrorHandler: class extends Error {
    statusCode: number;
    constructor(code: number, msg: string) {
      super(msg);
      this.statusCode = code;
    }
  },
}));
vi.mock("@jtrack/shared/buffer", () => ({
  getBuffer: vi.fn((f) => ({ content: f.buffer })),
}));
vi.mock("@jtrack/shared/redis/helpers", () => ({
  createRedisHelpers: () => ({
    checkForgotPasswordRate: mockCheckRate,
    clearFailedResetAttempts: mockClearFailed,
    clearForgotPasswordRate: mockClearRate,
    deleteRedisValue: mockDel,
    getRedisValue: mockGet,
    setRedisValue: mockSet,
    trackFailedResetAttempt: mockTrackFailed,
  }),
  withCache: mockWithCache,
}));
vi.mock("../../redis", () => ({
  redisClient: { get: mockRedisGet, set: mockRedisSet, setEx: mockRedisSetEx, del: mockRedisDel },
}));
vi.mock("../../kafka", () => ({ kafka: { publish: mockKafkaPublish } }));
vi.mock("../../template", () => ({
  resetPasswordEmailTemplate: vi.fn(() => "<html>"),
}));

const MODULES = await import("../auth");

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    params: {},
    cookies: {},
    file: undefined,
    on: vi.fn(),
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = { statusCode: 0 };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((data: unknown) => data);
  res.cookie = vi.fn();
  res.clearCookie = vi.fn();
  return res as import("express").Response;
}

describe("register", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 400 when required fields are missing", async () => {
    const res = mockRes();
    await MODULES.register(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: expect.any(String) });
  });

  it("throws 400 if email already exists", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ email: "a@b.com" });
    const res = mockRes();
    await MODULES.register(mockReq({ body: { name: "A", email: "a@b.com", password: "123456", phone_number: "123", role: "recruiter" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 400 for invalid role", async () => {
    mockUserFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await MODULES.register(mockReq({ body: { name: "A", email: "a@b.com", password: "123456", phone_number: "123", role: "admin" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("registers a recruiter successfully", async () => {
    mockUserFindFirst.mockResolvedValueOnce(null);
    mockUserCreate.mockResolvedValueOnce({ user_id: 1, name: "A", email: "a@b.com", phone_number: "123", role: "recruiter", created_at: new Date() });
    const res = mockRes();
    await MODULES.register(mockReq({ body: { name: "A", email: "a@b.com", password: "123456", phone_number: "123", role: "recruiter" } }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ message: "User registered successfully. Please login." });
  });
});

describe("login", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 400 when credentials missing", async () => {
    const res = mockRes();
    await MODULES.login(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 401 for wrong email", async () => {
    mockUserFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await MODULES.login(mockReq({ body: { email: "a@b.com", password: "x" } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("throws 401 for wrong password", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ user_id: 1, name: "A", email: "a@b.com", password: "hashed", role: "recruiter" });
    mockBcryptCompare.mockResolvedValueOnce(false);
    const res = mockRes();
    await MODULES.login(mockReq({ body: { email: "a@b.com", password: "wrong" } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("logs in successfully", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ user_id: 1, name: "A", email: "a@b.com", password: "hashed", role: "recruiter" });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockUserUpdate.mockResolvedValueOnce({});
    const res = mockRes();
    await MODULES.login(mockReq({ body: { email: "a@b.com", password: "correct" } }), res);
    expect(res.cookie).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Login success" }));
  });
});

describe("logout", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 401 without user", async () => {
    const res = mockRes();
    await MODULES.logout(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("logs out successfully", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ user_id: 1, refresh_token: "rt" });
    mockUserUpdate.mockResolvedValueOnce({});
    const res = mockRes();
    await MODULES.logout(mockReq({ user: { user_id: 1 }, cookies: { refreshToken: "rt" } }), res);
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe("getMe", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 401 without user", async () => {
    const res = mockRes();
    await MODULES.getMe(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns user profile", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ user_id: 1, name: "A", role: "recruiter" });
    const res = mockRes();
    await MODULES.getMe(mockReq({ user: { user_id: 1 } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe("forgotPassword", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 400 without email", async () => {
    const res = mockRes();
    await MODULES.forgotPassword(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns generic message even if email not found", async () => {
    mockUserFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await MODULES.forgotPassword(mockReq({ body: { email: "nobody@b.com" } }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.stringContaining("reset link") });
  });

  it("sends reset email for existing user", async () => {
    mockUserFindFirst.mockResolvedValueOnce({ user_id: 1, email: "a@b.com", name: "A" });
    process.env.FRONTEND_URL = "http://localhost:3000";
    const res = mockRes();
    await MODULES.forgotPassword(mockReq({ body: { email: "a@b.com" } }), res);
    expect(mockKafkaPublish).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe("resetPassword", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 400 without token or password", async () => {
    const res = mockRes();
    await MODULES.resetPassword(mockReq({ params: {}, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 400 for short password", async () => {
    const res = mockRes();
    await MODULES.resetPassword(mockReq({ params: { token: "t" }, body: { newPassword: "short" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("changePassword", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("throws 400 without passwords", async () => {
    const res = mockRes();
    await MODULES.changePassword(mockReq({ user: { user_id: 1 }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 400 if new password is too short", async () => {
    const res = mockRes();
    await MODULES.changePassword(mockReq({ user: { user_id: 1 }, body: { currentPassword: "old", newPassword: "short" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("throws 400 if passwords are the same", async () => {
    const res = mockRes();
    await MODULES.changePassword(mockReq({ user: { user_id: 1 }, body: { currentPassword: "samepass", newPassword: "samepass" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
