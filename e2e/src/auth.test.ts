import { describe, it, expect, beforeAll } from "vitest";
import { api } from "./client.ts";
import { ENDPOINTS } from "./config.ts";
import {
  registerUser,
  loginUser,
  registerAndLogin,
  changePassword,
} from "./helpers.ts";
import { generateRecruiter, generateJobseeker } from "./fixtures.ts";

describe("Auth Module", () => {
  describe("POST /api/auth/register", () => {
    it("registers a recruiter successfully", async () => {
      const user = generateRecruiter();
      const { status, body } = await registerUser(user);

      expect(status).toBe(201);
      expect(body).toEqual({
        message: "User registered successfully. Please login.",
      });
    });

    it("registers a jobseeker successfully", async () => {
      const user = generateJobseeker();
      const { status, body } = await registerUser(user);

      expect(status).toBe(201);
      expect(body).toHaveProperty("message");
    });

    it("rejects duplicate email registration", async () => {
      const user = generateRecruiter();
      await registerUser(user);

      const { status, body } = await registerUser(user);
      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });

    it("rejects registration with missing fields", async () => {
      const { status, body } = await api.post(ENDPOINTS.AUTH.REGISTER, {
        email: "missing@test.com",
      });
      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });

    it("rejects invalid role", async () => {
      const user = generateRecruiter({ role: "admin" as "recruiter" });
      const { status, body } = await registerUser(user);
      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/login", () => {
    it("logs in with valid credentials and returns cookies", async () => {
      const user = generateRecruiter();
      await registerUser(user);

      const res = await api.post<{ success: boolean; message: string; user: { user_id: number; name: string; email: string; role: string } }>(
        ENDPOINTS.AUTH.LOGIN,
        { email: user.email, password: user.password },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Login success");
      expect(res.body.user).toMatchObject({
        name: user.name,
        email: user.email,
        role: "recruiter",
      });
      expect(res.body.user.user_id).toBeGreaterThan(0);
      expect(res.cookies.has("accessToken")).toBe(true);
      expect(res.cookies.has("refreshToken")).toBe(true);
    });

    it("rejects invalid password", async () => {
      const user = generateRecruiter();
      await registerUser(user);

      const { status, body } = await api.post(ENDPOINTS.AUTH.LOGIN, {
        email: user.email,
        password: "wrongpassword",
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty("message");
    });

    it("rejects non-existent email", async () => {
      const { status, body } = await api.post(ENDPOINTS.AUTH.LOGIN, {
        email: "nonexistent.e2e@test.com",
        password: "SomePass1!",
      });

      expect(status).toBe(401);
      expect(body).toHaveProperty("message");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns authenticated user data", async () => {
      const session = await registerAndLogin(generateRecruiter());

      const res = await api.get<{
        success: boolean;
        user: { user_id: number; name: string; email: string; role: string };
      }>(ENDPOINTS.AUTH.ME, session.cookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe(session.user.name);
      expect(res.body.user.email).toBe(session.user.email);
      expect(res.body.user.role).toBe("recruiter");
    });

    it("returns 401 without authentication", async () => {
      const { status, body } = await api.get(ENDPOINTS.AUTH.ME);
      expect(status).toBe(401);
      expect(body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("logs out successfully and clears cookies", async () => {
      const session = await registerAndLogin(generateRecruiter());

      const res = await api.post<{ success: boolean; message: string }>(
        ENDPOINTS.AUTH.LOGOUT,
        undefined,
        session.cookies,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Logged out");

      const expiredAccess = res.cookies.get("accessToken");
      const expiredRefresh = res.cookies.get("refreshToken");
      if (expiredAccess) {
        expect(expiredAccess).toBe("");
      }
      if (expiredRefresh) {
        expect(expiredRefresh).toBe("");
      }

      // Subsequent request with cleared cookies should fail
      const meRes = await api.get(ENDPOINTS.AUTH.ME, res.cookies);
      expect(meRes.status).toBe(401);
    });
  });

  describe("PATCH /api/auth/change-password", () => {
    it("changes password successfully", async () => {
      const user = generateRecruiter();
      const session = await registerAndLogin(user);
      const newPassword = "NewStrongPass1!";

      const { status, body } = await changePassword(
        session,
        user.password,
        newPassword,
      );
      expect(status).toBe(200);
      expect(body).toHaveProperty("message");

      // Login with new password
      const loginRes = await api.post(ENDPOINTS.AUTH.LOGIN, {
        email: user.email,
        password: newPassword,
      });
      expect(loginRes.status).toBe(200);
    });

    it("rejects incorrect current password", async () => {
      const session = await registerAndLogin(generateRecruiter());

      const { status, body } = await changePassword(
        session,
        "wrongpassword",
        "NewStrongPass1!",
      );
      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });

    it("rejects weak new password", async () => {
      const session = await registerAndLogin(generateRecruiter());

      const { status, body } = await changePassword(
        session,
        session.user.password,
        "short",
      );
      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/forgot-password", () => {
    it("initiates password reset for registered email", async () => {
      const user = generateRecruiter();
      await registerUser(user);

      const { status, body } = await api.post(
        ENDPOINTS.AUTH.FORGOT_PASSWORD,
        { email: user.email },
      );

      expect(status).toBe(200);
      expect(body).toHaveProperty("message");
    });

    it("returns generic message for unregistered email (security)", async () => {
      const { status, body } = await api.post(
        ENDPOINTS.AUTH.FORGOT_PASSWORD,
        { email: "unknown.e2e@test.com" },
      );

      // Security best practice: don't reveal if email exists
      expect([200, 401, 429]).toContain(status);
      expect(body).toHaveProperty("message");
    });
  });

  describe("POST /api/auth/reset-password/:token", () => {
    it("rejects invalid reset token", async () => {
      const { status, body } = await api.post(
        `${ENDPOINTS.AUTH.RESET_PASSWORD}/invalidtoken123`,
        { newPassword: "NewStrongPass1!" },
      );

      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });
  });
});
