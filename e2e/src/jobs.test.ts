import { describe, it, expect } from "vitest";
import { api } from "./client.ts";
import { ENDPOINTS, type ServiceName } from "./config.ts";
import { registerAndLogin } from "./helpers.ts";
import { generateRecruiter, generateJobseeker, generateCompany, generateJob } from "./fixtures.ts";

const jobs: ServiceName = "jobs";

interface CompanyResponse {
  success: boolean;
  company?: { company_id: number; name: string };
  companies?: Array<{ company_id: number; name: string }>;
  message?: string;
}

interface JobResponse {
  success: boolean;
  job?: {
    job_id: number;
    title: string;
    company_id: number;
    is_active: boolean;
  };
  jobs?: Array<{
    job_id: number;
    title: string;
    company_id: number;
    is_active: boolean;
  }>;
  message?: string;
}

interface ApplicationResponse {
  success: boolean;
  application?: { application_id: number; status: string };
  applications?: Array<{
    application_id: number;
    job_id: number;
    status: string;
  }>;
  message?: string;
}

describe("Jobs Module", () => {
  describe("Company CRUD", () => {
    it("recruiter creates a company", async () => {
      const session = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      const res = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        {
          name: company.name,
          description: company.description,
          website: company.website,
        },
        session.cookies,
        jobs,
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.company).toBeDefined();
      expect(res.body.company!.name).toBe(company.name);
    });

    it("prevents duplicate company names", async () => {
      const session = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      await api.post(ENDPOINTS.JOBS.CREATE_COMPANY, company, session.cookies, jobs);

      const { status, body } = await api.post(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        session.cookies,
        jobs,
      );

      expect(status).toBe(400);
      expect(body).toHaveProperty("message");
    });

    it("lists all companies", async () => {
      const res = await api.get<CompanyResponse>(ENDPOINTS.JOBS.COMPANIES, undefined, jobs);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.companies)).toBe(true);
    });

    it("prevents jobseeker from creating a company", async () => {
      const session = await registerAndLogin(generateJobseeker());
      const company = generateCompany();

      const { status, body } = await api.post(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        session.cookies,
        jobs,
      );

      expect(status).toBe(403);
      expect(body).toHaveProperty("message");
    });
  });

  describe("Job CRUD", () => {
    it("recruiter creates a job for their company", async () => {
      const session = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      const companyRes = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        session.cookies,
        jobs,
      );
      const companyId = companyRes.body.company!.company_id;
      const job = generateJob({ title: "Senior Backend Engineer - E2E" });

      const res = await api.post<JobResponse>(
        ENDPOINTS.JOBS.CREATE_JOB,
        { ...job, company_id: companyId },
        session.cookies,
        jobs,
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.job).toBeDefined();
      expect(res.body.job!.title).toBe("Senior Backend Engineer - E2E");
      expect(res.body.job!.is_active).toBe(true);
    });

    it("lists active jobs publicly", async () => {
      const res = await api.get<JobResponse>(ENDPOINTS.JOBS.ACTIVE_JOBS, undefined, jobs);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it("prevents jobseeker from creating a job", async () => {
      const session = await registerAndLogin(generateJobseeker());
      const job = generateJob();

      const { status } = await api.post(
        ENDPOINTS.JOBS.CREATE_JOB,
        { ...job, company_id: 1 },
        session.cookies,
        jobs,
      );

      expect(status).toBe(403);
    });

    it("recruiter deletes their own job", async () => {
      const session = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      const companyRes = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        session.cookies,
        jobs,
      );
      const companyId = companyRes.body.company!.company_id;

      const jobRes = await api.post<JobResponse>(
        ENDPOINTS.JOBS.CREATE_JOB,
        { ...generateJob(), company_id: companyId },
        session.cookies,
        jobs,
      );
      const jobId = jobRes.body.job!.job_id;

      const deleteRes = await api.delete<{ success: boolean; message: string }>(
        ENDPOINTS.JOBS.DELETE_JOB(jobId),
        session.cookies,
        jobs,
      );

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    });
  });

  describe("Application Flow", () => {
    it("full flow: recruiter creates job, jobseeker applies, recruiter sees application", async () => {
      const recruiterSession = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      const companyRes = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        recruiterSession.cookies,
        jobs,
      );
      const companyId = companyRes.body.company!.company_id;

      const jobRes = await api.post<JobResponse>(
        ENDPOINTS.JOBS.CREATE_JOB,
        { ...generateJob({ title: "E2E Full Flow Position" }), company_id: companyId },
        recruiterSession.cookies,
        jobs,
      );
      const jobId = jobRes.body.job!.job_id;

      const jobseekerSession = await registerAndLogin(generateJobseeker());

      const applyRes = await api.post<ApplicationResponse>(
        ENDPOINTS.JOBS.APPLY,
        { job_id: jobId },
        jobseekerSession.cookies,
        jobs,
      );

      expect(applyRes.status).toBe(201);
      expect(applyRes.body.success).toBe(true);
      expect(applyRes.body.application).toBeDefined();
      expect(applyRes.body.application!.status).toBe("Applied");

      const myAppsRes = await api.get<ApplicationResponse>(
        ENDPOINTS.JOBS.MY_APPLICATIONS,
        jobseekerSession.cookies,
        jobs,
      );

      expect(myAppsRes.status).toBe(200);
      expect(myAppsRes.body.success).toBe(true);
      expect(myAppsRes.body.applications!.length).toBeGreaterThanOrEqual(1);
      expect(
        myAppsRes.body.applications!.some((a) => a.job_id === jobId),
      ).toBe(true);

      const recruiterAppsRes = await api.get<ApplicationResponse>(
        ENDPOINTS.JOBS.APPLICATIONS_BY_JOB(jobId),
        recruiterSession.cookies,
        jobs,
      );

      expect(recruiterAppsRes.status).toBe(200);
      expect(recruiterAppsRes.body.success).toBe(true);
      expect(recruiterAppsRes.body.applications!.length).toBeGreaterThanOrEqual(1);
    });

    it("prevents duplicate applications", async () => {
      const recruiterSession = await registerAndLogin(generateRecruiter());
      const company = generateCompany();

      const companyRes = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        company,
        recruiterSession.cookies,
        jobs,
      );
      const jobRes = await api.post<JobResponse>(
        ENDPOINTS.JOBS.CREATE_JOB,
        { ...generateJob(), company_id: companyRes.body.company!.company_id },
        recruiterSession.cookies,
        jobs,
      );
      const jobId = jobRes.body.job!.job_id;

      const jobseekerSession = await registerAndLogin(generateJobseeker());

      await api.post(
        ENDPOINTS.JOBS.APPLY,
        { job_id: jobId },
        jobseekerSession.cookies,
        jobs,
      );

      const { status, body } = await api.post(
        ENDPOINTS.JOBS.APPLY,
        { job_id: jobId },
        jobseekerSession.cookies,
        jobs,
      );

      expect(status).toBe(409);
      expect(body).toHaveProperty("message");
    });

    it("prevents jobseeker from applying as recruiter", async () => {
      const session = await registerAndLogin(generateRecruiter());

      const { status, body } = await api.post(
        ENDPOINTS.JOBS.APPLY,
        { job_id: 1 },
        session.cookies,
        jobs,
      );

      expect(status).toBe(403);
      expect(body).toHaveProperty("message");
    });

    it("prevents unauthorized application access", async () => {
      const { status } = await api.post(
        ENDPOINTS.JOBS.APPLY,
        { job_id: 1 },
        undefined,
        jobs,
      );
      expect(status).toBe(401);
    });
  });

  describe("Application Status Updates", () => {
    it("recruiter updates application status", async () => {
      const recruiterSession = await registerAndLogin(generateRecruiter());
      const companyRes = await api.post<CompanyResponse>(
        ENDPOINTS.JOBS.CREATE_COMPANY,
        generateCompany(),
        recruiterSession.cookies,
        jobs,
      );
      const jobRes = await api.post<JobResponse>(
        ENDPOINTS.JOBS.CREATE_JOB,
        {
          ...generateJob({ title: "Status Update Test" }),
          company_id: companyRes.body.company!.company_id,
        },
        recruiterSession.cookies,
        jobs,
      );
      const jobId = jobRes.body.job!.job_id;

      const jobseekerSession = await registerAndLogin(generateJobseeker());
      const applyRes = await api.post<ApplicationResponse>(
        ENDPOINTS.JOBS.APPLY,
        { job_id: jobId },
        jobseekerSession.cookies,
        jobs,
      );
      const applicationId = applyRes.body.application!.application_id;

      const updateRes = await api.patch<{ success: boolean; message: string }>(
        ENDPOINTS.JOBS.APPLICATION(applicationId),
        { status: "Hired" },
        recruiterSession.cookies,
        jobs,
      );

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.success).toBe(true);

      const appsRes = await api.get<ApplicationResponse>(
        ENDPOINTS.JOBS.APPLICATIONS_BY_JOB(jobId),
        recruiterSession.cookies,
        jobs,
      );
      const updatedApp = appsRes.body.applications!.find(
        (a) => a.application_id === applicationId,
      );
      expect(updatedApp).toBeDefined();
      expect(updatedApp!.status).toBe("Hired");
    });

    it("rejects status update from non-recruiter", async () => {
      const session = await registerAndLogin(generateJobseeker());

      const { status } = await api.patch(
        ENDPOINTS.JOBS.APPLICATION(1),
        { status: "Hired" },
        session.cookies,
        jobs,
      );

      expect(status).toBe(403);
    });
  });
});
