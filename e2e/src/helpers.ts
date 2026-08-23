import { api } from "./client.ts";
import { ENDPOINTS } from "./config.ts";
import type { TestUser } from "./fixtures.ts";
import { createClient, type RedisClientType } from "redis";

export interface AuthSession {
  user: TestUser;
  cookies: Map<string, string>;
  userId?: number;
}

/**
 * Verify a freshly registered test user's email by pulling the real
 * verification token from Redis (key format: `verify:{user_id}{email}`).
 * This exercises the production verification flow instead of bypassing it.
 */
export async function verifyUserEmail(user: TestUser): Promise<void> {
  const url = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "E2E_REDIS_URL or REDIS_URL must be set so tests can complete email verification",
    );
  }

  const client = createClient({ url }) as RedisClientType;
  try {
    await client.connect();
    const pattern = `verify:*${user.email}`;
    const keys = await client.keys(pattern);
    if (keys.length === 0) {
      throw new Error(`No verification token found in Redis for ${user.email}`);
    }
    const token = await client.get(keys[0]);
    if (!token) {
      throw new Error(`Verification token empty for ${user.email}`);
    }
    const res = await api.post(ENDPOINTS.AUTH.VERIFY_EMAIL, { token });
    if (res.status !== 200) {
      throw new Error(
        `Email verification failed (${res.status}): ${JSON.stringify(res.body)}`,
      );
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export async function registerUser(
  user: TestUser,
): Promise<{ status: number; body: unknown }> {
  const res = await api.post(ENDPOINTS.AUTH.REGISTER, {
    name: user.name,
    email: user.email,
    password: user.password,
    phone_number: user.phone_number,
    role: user.role,
  });
  return { status: res.status, body: res.body };
}

export async function loginUser(
  user: TestUser,
): Promise<AuthSession> {
  const res = await api.post<{ success: boolean; message: string; user?: { user_id: number } }>(
    ENDPOINTS.AUTH.LOGIN,
    { email: user.email, password: user.password },
  );

  return {
    user,
    cookies: res.cookies,
    userId: res.body?.user?.user_id,
  };
}

export async function registerAndLogin(
  user: TestUser,
): Promise<AuthSession> {
  await registerUser(user);
  // The backend requires email verification before login — complete the
  // real verification flow (token pulled from Redis) so the session is
  // created through the same path production users take.
  await verifyUserEmail(user);
  return loginUser(user);
}

/** Minimal single-page PDF with extractable text (pdf-parse needs ≥50 chars). */
function minimalResumePdf(name: string): Buffer {
  const lines = [
    name,
    "E2E Test Engineer",
    "",
    "SKILLS",
    "JavaScript, TypeScript, Node.js, PostgreSQL, Docker",
    "",
    "EXPERIENCE",
    "Built and tested distributed job platform services end to end.",
    "Wrote automated regression suites covering auth, jobs and AI flows.",
  ];
  const content =
    `BT /F1 11 Tf 50 800 Td 14 TL\n` +
    lines.map((l) => `(${l.replace(/([()\\])/g, "\\$1")}) Tj T*`).join("\n") +
    `\nET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const xref = out.length;
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * Jobseekers cannot apply without a resume. Upload a generated PDF through
 * the real endpoint so application flows exercise production behavior.
 */
export async function ensureResume(session: AuthSession): Promise<void> {
  const form = new FormData();
  form.append(
    "resume",
    new Blob([new Uint8Array(minimalResumePdf(session.user.name))], { type: "application/pdf" }),
    "e2e-resume.pdf",
  );
  const res = await api.post(ENDPOINTS.USER.RESUME, form, session.cookies, "user");
  if (res.status !== 200) {
    throw new Error(`Resume upload failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
}

export async function changePassword(
  session: AuthSession,
  currentPassword: string,
  newPassword: string,
): Promise<{ status: number; body: unknown }> {
  const res = await api.patch(
    ENDPOINTS.AUTH.CHANGE_PASSWORD,
    { currentPassword, newPassword },
    session.cookies,
  );
  return { status: res.status, body: res.body };
}

export async function deleteUserAccount(userId: number): Promise<void> {
  // can't delete themselves via API; this is a placeholder

  console.log(`[cleanup] User ${userId} would be cleaned up`);
}
