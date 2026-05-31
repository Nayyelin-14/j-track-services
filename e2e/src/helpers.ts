import { api } from "./client.ts";
import { ENDPOINTS } from "./config.ts";
import type { TestUser } from "./fixtures.ts";

export interface AuthSession {
  user: TestUser;
  cookies: Map<string, string>;
  userId?: number;
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
  return loginUser(user);
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
