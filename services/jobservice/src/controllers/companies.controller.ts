import { Request, Response, NextFunction } from "express";
import axios from "axios";
import { prisma } from "@jtrack/shared/db";
import { TryCatch } from "@jtrack/shared/tryCatch";
import { ErrorHandler } from "@jtrack/shared/errorHandler";
import type { AuthRequest } from "@jtrack/shared/types";
import { withCache } from "@jtrack/shared/redis/helpers";
import { getBuffer } from "@jtrack/shared/buffer";
import { redisClient } from "../redis.js";
import {
  CACHE_KEYS,
  invalidateCompaniesCache,
  sanitize,
  sanitizePositiveInt,
  COMPANIES_LIST_VERSION_KEY,
  getListVersion,
} from "./utils.js";

export const createCompany = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can create a company"),
      );
    }

    const name = sanitize(req.body.name, "Name", 255);
    const description = sanitize(req.body.description, "Description", 5000);
    const website = sanitize(req.body.website, "Website", 255);

    try {
      const url = new URL(website);
      if (!["http:", "https:"].includes(url.protocol)) {
        return next(new ErrorHandler(400, "Website must be http or https"));
      }
    } catch {
      return next(new ErrorHandler(400, "Website must be a valid URL"));
    }

    const existing = await prisma.company.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { company_id: true },
    });
    if (existing) {
      return next(new ErrorHandler(409, "Company name already taken"));
    }

    let logo: string | null = null;
    let logo_public_id: string | null = null;

    if (req.file) {
      const allowed = ["image/jpeg", "image/png", "image/webp"];
      if (!allowed.includes(req.file.mimetype)) {
        return next(new ErrorHandler(400, "Logo must be JPEG, PNG, or WebP"));
      }
      if (req.file.size > 5 * 1024 * 1024) {
        return next(new ErrorHandler(400, "Logo must be smaller than 5 MB"));
      }

      const dataUri = getBuffer(req.file);
      if (!dataUri?.content) {
        return next(new ErrorHandler(500, "Failed to process logo"));
      }

      const uploadRes = await axios.post(
        `${process.env.UTILS_SERVICE_URL}/upload`,
        { buffer: dataUri.content },
      );

      if (!uploadRes.data.success) {
        return next(new ErrorHandler(500, "Logo upload failed"));
      }

      logo = uploadRes.data.url;
      logo_public_id = uploadRes.data.public_id;
    }

    const company = await prisma.company.create({
      data: {
        name,
        description,
        website,
        logo,
        logo_public_id,
        recruiter_id: req.user.user_id,
      },
      select: {
        company_id: true,
        name: true,
        description: true,
        website: true,
        logo: true,
        created_at: true,
      },
    });

    await invalidateCompaniesCache();

    return res.status(201).json({
      success: true,
      message: "Company created successfully",
      company,
    });
  },
);

export const deleteCompany = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can delete a company"),
      );
    }

    const companyId = parseInt(req.params.id as string);
    if (isNaN(companyId) || companyId <= 0) {
      return next(new ErrorHandler(400, "Invalid company ID"));
    }

    const company = await prisma.company.findFirst({
      where: { company_id: companyId },
      select: { company_id: true, recruiter_id: true, logo_public_id: true },
    });
    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }

    if (company.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You are not authorized to delete this company"),
      );
    }

    if (company.logo_public_id) {
      try {
        await axios.delete(
          `${process.env.UTILS_SERVICE_URL}/${encodeURIComponent(company.logo_public_id)}`,
        );
      } catch (err) {
        console.error("Cloudinary delete failed (non-fatal):", err);
      }
    }

    await prisma.company.delete({
      where: { company_id: companyId },
    });

    await invalidateCompaniesCache(companyId);

    return res.status(200).json({
      success: true,
      message: "Company deleted successfully",
    });
  },
);

export const getAllCompanies = TryCatch(
  async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const version = await getListVersion(COMPANIES_LIST_VERSION_KEY);
    const cacheKey = `companies:list:v${version};page=${page};limit=${limit}`;

    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.status(200).json({
          success: true,
          count: parsed.companies.length,
          total: parsed.total,
          page,
          totalPages: Math.ceil(parsed.total / limit),
          companies: parsed.companies,
          fromCache: true,
        });
      }
    } catch (err) {
      console.warn("[Redis] Cache read error (non-fatal):", err);
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        select: {
          company_id: true,
          name: true,
          description: true,
          website: true,
          location: true,
          logo: true,
          created_at: true,
        },
        orderBy: { created_at: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.company.count(),
    ]);

    try {
      await redisClient.setEx(
        cacheKey,
        300,
        JSON.stringify({ companies, total }),
      );
    } catch (err) {
      console.warn("[Redis] Cache write error (non-fatal):", err);
    }

    return res.status(200).json({
      success: true,
      count: companies.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      companies,
    });
  },
);

export const getCompanyById = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const company_id = sanitizePositiveInt(req.params.company_id, "Company ID");

    const { data: company, fromCache } = await withCache(
      redisClient,
      CACHE_KEYS.company(company_id),
      300,
      async () => {
        const company = await prisma.company.findFirst({
          where: { company_id },
          select: {
            company_id: true,
            name: true,
            description: true,
            website: true,
            location: true,
            logo: true,
            created_at: true,
          },
        });

        if (!company) {
          throw new ErrorHandler(404, "Company not found");
        }

        return company;
      },
    );

    return res.status(200).json({
      success: true,
      company,
      ...(fromCache && { fromCache }),
    });
  },
);

export const getCompanyDetail = TryCatch(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler(401, "Unauthorized"));
    }

    if (req.user.role !== "recruiter") {
      return next(
        new ErrorHandler(403, "Only recruiters can access company details"),
      );
    }

    const company_id = sanitizePositiveInt(req.params.company_id, "Company ID");

    const cacheKey = CACHE_KEYS.companyDetail(company_id);
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed.recruiter_id === req.user.user_id) {
            return res.status(200).json({ success: true, company: parsed.data, fromCache: true });
          }
        } catch {
          console.warn("[Redis] Cache parse error, skipping cache");
        }
      }
    } catch (err) {
      console.error("[Redis] Cache read error (non-fatal):", err);
    }

    const [company] = await prisma.$queryRaw<any[]>`
      SELECT
        c.company_id, c.name, c.description, c.website, c.logo,
        c.logo_public_id, c.created_at, c.recruiter_id,
        u.user_id, u.name AS recruiter_name, u.email AS recruiter_email,
        COALESCE(
          JSON_AGG(
            CASE
              WHEN j.job_id IS NOT NULL THEN
                JSON_BUILD_OBJECT(
                  'job_id', j.job_id,
                  'title', j.title,
                  'description', j.description,
                  'salary', j.salary,
                  'location', j.location,
                  'job_type', j.job_type,
                  'openings', j.openings,
                  'role', j.role,
                  'work_location', j.work_location,
                  'is_active', j.is_active,
                  'created_at', j.created_at
                )
            END
          ) FILTER (WHERE j.job_id IS NOT NULL),
          '[]'
        ) AS jobs
      FROM companies c
      INNER JOIN users u ON c.recruiter_id = u.user_id
      LEFT JOIN jobs j ON c.company_id = j.company_id
      WHERE c.company_id = ${company_id}
      GROUP BY c.company_id, u.user_id
      LIMIT 1
    `;

    if (!company) {
      return next(new ErrorHandler(404, "Company not found"));
    }

    if (company.recruiter_id !== req.user.user_id) {
      return next(
        new ErrorHandler(403, "You can only access your own company"),
      );
    }

    const cacheValue = JSON.stringify({
      recruiter_id: company.recruiter_id,
      data: {
        company_id: company.company_id,
        name: company.name,
        description: company.description,
        website: company.website,
        logo: company.logo,
        logo_public_id: company.logo_public_id,
        created_at: company.created_at,
        recruiter: {
          user_id: company.user_id,
          name: company.recruiter_name,
          email: company.recruiter_email,
        },
        jobs: company.jobs,
      },
    });

    try {
      await redisClient.setEx(cacheKey, 300, cacheValue);
    } catch (err) {
      console.error("[Redis] Cache write error (non-fatal):", err);
    }

    return res.status(200).json({
      success: true,
      company: {
        company_id: company.company_id,
        name: company.name,
        description: company.description,
        website: company.website,
        logo: company.logo,
        logo_public_id: company.logo_public_id,
        created_at: company.created_at,
        recruiter: {
          user_id: company.user_id,
          name: company.recruiter_name,
          email: company.recruiter_email,
        },
        jobs: company.jobs,
      },
    });
  },
);
