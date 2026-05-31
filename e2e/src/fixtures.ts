export interface TestUser {
  name: string;
  email: string;
  password: string;
  phone_number: string;
  role: "recruiter" | "jobseeker";
}

export interface TestCompany {
  name: string;
  description: string;
  website: string;
}

export interface TestJob {
  title: string;
  description: string;
  location: string;
  role: string;
  job_type: string;
  work_location: string;
  openings: number;
  salary: number;
}

export function uniqueEmail(base: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return base.replace("@", `+${ts}-${rand}@`);
}

export function generateRecruiter(overrides?: Partial<TestUser>): TestUser {
  return {
    name: "Recruiter E2E",
    email: uniqueEmail("recruiter.e2e@test.com"),
    password: "StrongPass1!",
    phone_number: "09123456001",
    role: "recruiter",
    ...overrides,
  };
}

export function generateJobseeker(overrides?: Partial<TestUser>): TestUser {
  return {
    name: "Jobseeker E2E",
    email: uniqueEmail("jobseeker.e2e@test.com"),
    password: "StrongPass1!",
    phone_number: "09123456002",
    role: "jobseeker",
    ...overrides,
  };
}

export function generateCompany(overrides?: Partial<TestCompany>): TestCompany {
  return {
    name: `E2E-Corp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: "Temporary company for E2E testing",
    website: "https://e2e.example.com",
    ...overrides,
  };
}

export function generateJob(overrides?: Partial<TestJob>): TestJob {
  return {
    title: "E2E Test Engineer",
    description: "Testing position - will be deleted after test",
    location: "Remote",
    role: "Engineer",
    job_type: "Full-time",
    work_location: "Remote",
    openings: 1,
    salary: 100000,
    ...overrides,
  };
}
