import { Router } from "express";
import multer from "multer";
import { isAuthenticated } from "@jtrack/shared/isauthenticated";
import {
  createCompany,
  deleteCompany,
  getAllCompanies,
  getCompanyById,
  getCompanyDetail,
} from "../controllers/companies.controller.js";
import {
  createJob,
  deleteJob,
  updateJob,
  getAllActiveJobs,
  getJobById,
} from "../controllers/jobs.controller.js";
import {
  applyJob,
  getApplications,
  getApplicationsByRecruiterJob,
  updateJobApplication,
} from "../controllers/applications.controller.js";
import { analyzeJobMatch } from "../controllers/match.con.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── Companies ────────────────────────────────────────────────────────────
router.post(
  "/create-com",
  isAuthenticated,
  upload.single("logo"),
  createCompany,
);
router.get("/", getAllCompanies);
router.get("/:company_id", getCompanyById);
router.get("/detail/:company_id", isAuthenticated, getCompanyDetail);
router.delete("/:id", isAuthenticated, deleteCompany);

// ── Jobs ─────────────────────────────────────────────────────────────────
router.post("/create-job", isAuthenticated, createJob);
router.delete("/jobs/:job_id", isAuthenticated, deleteJob);
router.patch("/jobs/:job_id", isAuthenticated, updateJob);
router.get("/active-jobs", getAllActiveJobs);
router.get("/jobs/:job_id", getJobById);

router.post("/apply", isAuthenticated, applyJob);
router.get("/my-applications", isAuthenticated, getApplications);
router.get(
  "/applications-by-job/:job_id",
  isAuthenticated,
  getApplicationsByRecruiterJob,
);
router.patch(
  "/applications/:application_id",
  isAuthenticated,
  updateJobApplication,
);

router.post("/analyze-match/:jobId", isAuthenticated, analyzeJobMatch);

export default router;
