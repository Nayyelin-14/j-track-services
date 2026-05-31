import { describe, it, expect } from "vitest";
import { api } from "./client.ts";
import { ENDPOINTS } from "./config.ts";
import { registerAndLogin } from "./helpers.ts";
import { generateRecruiter, generateJobseeker } from "./fixtures.ts";
import type { ServiceName } from "./config.ts";

const user: ServiceName = "user";

describe("User Module", () => {
  describe("GET /api/users/me", () => {
    it("returns authenticated user profile", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const res = await api.get<{
        success: boolean;
        user: { user_id: number; name: string; email: string; role: string };
      }>(ENDPOINTS.USER.ME, session.cookies, user);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe(session.user.name);
      expect(res.body.user.email).toBe(session.user.email);
    });

    it("returns 401 without auth", async () => {
      const { status } = await api.get(ENDPOINTS.USER.ME, undefined, user);
      expect(status).toBe(401);
    });
  });

  describe("PUT /api/users/update", () => {
    it("updates user profile name", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const res = await api.put<{ success: boolean; message: string; user: { name: string; phone_number: string } }>(
        ENDPOINTS.USER.UPDATE,
        { name: "Updated E2E Name", phone_number: "09123456999" },
        session.cookies,
        user,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe("Updated E2E Name");
      expect(res.body.user.phone_number).toBe("09123456999");
    });

    it("rejects update without auth", async () => {
      const { status } = await api.put(
        ENDPOINTS.USER.UPDATE,
        { name: "Hacker" },
        undefined,
        user,
      );
      expect(status).toBe(401);
    });
  });

  describe("PUT /api/users/bio", () => {
    it("updates user bio", async () => {
      const session = await registerAndLogin(generateJobseeker());
      const newBio = "E2E testing bio - updated at " + Date.now();

      const res = await api.put<{ success: boolean; message: string }>(
        ENDPOINTS.USER.BIO,
        { bio: newBio },
        session.cookies,
        user,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("Bio");
    });

    it("rejects empty bio", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const { status, body } = await api.put(
        ENDPOINTS.USER.BIO,
        { bio: "" },
        session.cookies,
        user,
      );

      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });
  });

  describe("GET /api/users/:id", () => {
    it("returns public user by id", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const res = await api.get<{
        success: boolean;
        user: { user_id: number; name: string };
      }>(ENDPOINTS.USER.BY_ID(session.userId!), session.cookies, user);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe(session.user.name);
    });

    it("returns 404 for non-existent user", async () => {
      const { status } = await api.get(ENDPOINTS.USER.BY_ID(999999), undefined, user);
      expect(status).toBe(404);
    });
  });

  describe("Skill Management", () => {
    it("adds and lists skills for a user", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const addRes = await api.post<{ success: boolean; message: string }>(
        ENDPOINTS.USER.ADD_SKILL,
        { skills: ["TypeScript", "Node.js", "PostgreSQL"] },
        session.cookies,
        user,
      );

      expect(addRes.status).toBe(200);
      expect(addRes.body.success).toBe(true);
    });

    it("removes a skill from user", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const addRes = await api.post<{
        success: boolean;
        skills: Array<{ skill_id: number; name: string }>;
      }>(
        ENDPOINTS.USER.ADD_SKILL,
        { skills: ["TypeScript"] },
        session.cookies,
        user,
      );

      expect(addRes.body.skills.length).toBeGreaterThan(0);
      const skillId = addRes.body.skills[0].skill_id;

      const removeRes = await api.delete<{ success: boolean; message: string }>(
        ENDPOINTS.USER.REMOVE_SKILL,
        { skill_ids: [skillId] },
        session.cookies,
        user,
      );

      expect(removeRes.status).toBe(200);
      expect(removeRes.body.success).toBe(true);
    });

    it("rejects skill operations without auth", async () => {
      const { status } = await api.post(
        ENDPOINTS.USER.ADD_SKILL,
        { skill_ids: [1] },
        undefined,
        user,
      );
      expect(status).toBe(401);
    });
  });

  describe("GET /api/users/skills", () => {
    it("returns all available skills", async () => {
      const res = await api.get<{
        success: boolean;
        count: number;
        skills: Array<{ skill_id: number; name: string }>;
      }>(ENDPOINTS.USER.SKILLS, undefined, user);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.skills)).toBe(true);
      if (res.body.count > 0) {
        expect(res.body.skills[0]).toHaveProperty("skill_id");
        expect(res.body.skills[0]).toHaveProperty("name");
      }
    });
  });
});
