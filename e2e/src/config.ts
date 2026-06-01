export type ServiceName = "auth" | "user" | "jobs" | "utils";

const servicePorts: Record<ServiceName, number> = {
  auth: 7000,
  user: 7001,
  jobs: 7002,
  utils: 6001,
};

const sharedBaseUrl = process.env.E2E_BASE_URL;

export function getBaseUrl(service: ServiceName): string {
  if (sharedBaseUrl) return sharedBaseUrl;

  const envVar = process.env[`E2E_${service.toUpperCase()}_URL`];
  if (envVar) return envVar;

  return `http://localhost:${servicePorts[service]}`;
}

export const ENDPOINTS = {
  AUTH: {
    REGISTER: "/api/auth/register",
    LOGIN: "/api/auth/login",
    LOGOUT: "/api/auth/logout",
    ME: "/api/auth/me",
    FORGOT_PASSWORD: "/api/auth/forgot-password",
    RESET_PASSWORD: "/api/auth/reset-password",
    CHANGE_PASSWORD: "/api/auth/change-password",
  },
  USER: {
    ME: "/api/users/me",
    UPDATE: "/api/users/update",
    BIO: "/api/users/bio",
    ADD_SKILL: "/api/users/add-skill",
    REMOVE_SKILL: "/api/users/remove-skill",
    SKILLS: "/api/users/skills",
    BY_ID: (id: number) => `/api/users/${id}`,
  },
  JOBS: {
    CREATE_COMPANY: "/api/jobs/create-com",
    COMPANIES: "/api/jobs/",
    COMPANY_BY_ID: (id: number) => `/api/jobs/${id}`,
    COMPANY_DETAIL: (id: number) => `/api/jobs/detail/${id}`,
    DELETE_COMPANY: (id: number) => `/api/jobs/${id}`,
    CREATE_JOB: "/api/jobs/create-job",
    ACTIVE_JOBS: "/api/jobs/active-jobs",
    JOB_BY_ID: (id: number) => `/api/jobs/jobs/${id}`,
    DELETE_JOB: (id: number) => `/api/jobs/jobs/${id}`,
    UPDATE_JOB: (id: number) => `/api/jobs/jobs/${id}`,
    APPLY: "/api/jobs/apply",
    MY_APPLICATIONS: "/api/jobs/my-applications",
    APPLICATIONS_BY_JOB: (id: number) => `/api/jobs/applications-by-job/${id}`,
    APPLICATION: (id: number) => `/api/jobs/applications/${id}`,
    ANALYZE_MATCH: (jobId: number) => `/api/jobs/analyze-match/${jobId}`,
    ANALYTICS: (jobId: number) => `/api/jobs/analytics/${jobId}`,
  },
  HEALTH: "/health",
} as const;
