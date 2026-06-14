import { describe, it, expect } from "vitest";
import { api } from "./client.ts";
import { ENDPOINTS, type ServiceName } from "./config.ts";
import { registerAndLogin } from "./helpers.ts";
import { generateRecruiter, generateJobseeker, generateCompany, generateJob } from "./fixtures.ts";

const userSvc: ServiceName = "user";
const jobsSvc: ServiceName = "jobs";

describe("Smoke: critical cross-service flow", () => {
  it("register → verify auth across services → create job → apply → verify", async () => {
    // --- RECRUITER FLOW ---

    // 1. Register + login recruiter (auth service)
    const recruiter = await registerAndLogin(generateRecruiter());
    expect(recruiter.cookies.has("accessToken")).toBe(true);

    // 2. Verify JWT works on a different service (user service)
    const meRes = await api.get<{ success: boolean; user: { user_id: number } }>(
      ENDPOINTS.USER.ME,
      recruiter.cookies,
      userSvc,
    );
    expect(meRes.status).toBe(200);
    const userId = meRes.body.user.user_id;
    expect(userId).toBeGreaterThan(0);

    // 3. Recruiter creates a company (jobservice)
    const company = generateCompany();
    const companyRes = await api.post<{
      success: boolean;
      company: { company_id: number };
    }>(ENDPOINTS.JOBS.CREATE_COMPANY, company, recruiter.cookies, jobsSvc);
    expect(companyRes.status).toBe(201);
    expect(companyRes.body.company.company_id).toBeGreaterThan(0);
    const companyId = companyRes.body.company.company_id;

    // 4. Recruiter creates a job posting (jobservice)
    const job = generateJob({ title: "Smoke Test Position" });
    const jobRes = await api.post<{
      success: boolean;
      job: { job_id: number; is_active: boolean };
    }>(ENDPOINTS.JOBS.CREATE_JOB, { ...job, company_id: companyId }, recruiter.cookies, jobsSvc);
    expect(jobRes.status).toBe(201);
    expect(jobRes.body.job.is_active).toBe(true);
    const jobId = jobRes.body.job.job_id;

    // --- JOBSEEKER FLOW ---

    // 5. Register + login jobseeker (auth service)
    const jobseeker = await registerAndLogin(generateJobseeker());
    expect(jobseeker.cookies.has("accessToken")).toBe(true);

    // 6. Verify jobseeker JWT on user service too
    const seekerMe = await api.get<{ success: boolean; user: { user_id: number } }>(
      ENDPOINTS.USER.ME,
      jobseeker.cookies,
      userSvc,
    );
    expect(seekerMe.status).toBe(200);

    // 7. Jobseeker applies to the job (jobservice)
    const applyRes = await api.post<{
      success: boolean;
      application: { application_id: number; status: string };
    }>(ENDPOINTS.JOBS.APPLY, { jobId }, jobseeker.cookies, jobsSvc);
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.application.status).toBe("Applied");

    // 8. Recruiter can see the application (jobservice)
    const appsRes = await api.get<{
      success: boolean;
      applications: Array<{ job_id: number; status: string }>;
    }>(ENDPOINTS.JOBS.APPLICATIONS_BY_JOB(jobId), recruiter.cookies, jobsSvc);
    expect(appsRes.status).toBe(200);
    expect(appsRes.body.applications.some((a) => a.job_id === jobId)).toBe(true);
  });
});
