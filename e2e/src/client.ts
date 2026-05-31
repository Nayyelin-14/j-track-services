import { getBaseUrl, type ServiceName } from "./config.ts";

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  cookies: Map<string, string>;
}

function parseCookies(headers: Headers): Map<string, string> {
  const cookies = new Map<string, string>();
  const setCookie = headers.getSetCookie();
  for (const entry of setCookie) {
    const [cookiePair] = entry.split(";");
    const [key, ...rest] = cookiePair.split("=");
    if (key && rest.length > 0) {
      cookies.set(key.trim(), rest.join("=").trim());
    }
  }
  return cookies;
}

function cookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function request<T = unknown>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookies?: Map<string, string>;
    service?: ServiceName;
  } = {},
): Promise<ApiResponse<T>> {
  const baseUrl = options.service ? getBaseUrl(options.service) : getBaseUrl("auth");
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {};

  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (options.cookies && options.cookies.size > 0) {
    headers["Cookie"] = cookieHeader(options.cookies);
  }

  const body =
    options.body instanceof FormData
      ? options.body
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;

  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  const responseCookies = parseCookies(response.headers);

  let responseBody: T;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    responseBody = (await response.json()) as T;
  } else {
    responseBody = (await response.text()) as unknown as T;
  }

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody,
    cookies: responseCookies,
  };
}

export const api = {
  get: <T>(path: string, cookies?: Map<string, string>, service?: ServiceName) =>
    request<T>("GET", path, { cookies, service }),

  post: <T>(path: string, body?: unknown, cookies?: Map<string, string>, service?: ServiceName) =>
    request<T>("POST", path, { body, cookies, service }),

  patch: <T>(path: string, body?: unknown, cookies?: Map<string, string>, service?: ServiceName) =>
    request<T>("PATCH", path, { body, cookies, service }),

  put: <T>(path: string, body?: unknown, cookies?: Map<string, string>, service?: ServiceName) =>
    request<T>("PUT", path, { body, cookies, service }),

  delete: <T>(path: string, body?: unknown, cookies?: Map<string, string>, service?: ServiceName) =>
    request<T>("DELETE", path, { body, cookies, service }),
};

export async function healthCheck(service?: ServiceName): Promise<boolean> {
  try {
    const res = await api.get<string>("/health", undefined, service);
    return res.status === 200;
  } catch {
    return false;
  }
}
