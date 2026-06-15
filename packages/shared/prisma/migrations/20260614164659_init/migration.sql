-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('jobseeker', 'recruiter');

-- CreateEnum
CREATE TYPE "subscription_tier" AS ENUM ('free', 'premium');

-- CreateEnum
CREATE TYPE "job_type" AS ENUM ('Full-time', 'Part-time', 'Contract', 'Internship');

-- CreateEnum
CREATE TYPE "work_location" AS ENUM ('On-site', 'Remote', 'Hybrid');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('Submitted', 'Rejected', 'Hired', 'Applied');

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "phone_number" VARCHAR(20) NOT NULL,
    "role" "user_role" NOT NULL,
    "bio" TEXT,
    "resume" VARCHAR(255),
    "refresh_token" TEXT,
    "resume_public_id" VARCHAR(255),
    "profile_pic" VARCHAR(255),
    "profile_pic_public_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subscription" TIMESTAMPTZ(6),
    "subscription_tier" "subscription_tier" NOT NULL DEFAULT 'free',
    "search_vector" tsvector,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "skills" (
    "skill_id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("skill_id")
);

-- CreateTable
CREATE TABLE "user_skills" (
    "user_id" INTEGER NOT NULL,
    "skill_id" INTEGER NOT NULL,

    CONSTRAINT "user_skills_pkey" PRIMARY KEY ("user_id","skill_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "company_id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "website" VARCHAR(255) NOT NULL,
    "location" VARCHAR(255),
    "logo" VARCHAR(255),
    "logo_public_id" VARCHAR(255),
    "recruiter_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "job_id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "salary" DECIMAL(10,2),
    "location" VARCHAR(255),
    "job_type" "job_type" NOT NULL,
    "openings" DECIMAL(3,1) NOT NULL,
    "role" VARCHAR(255) NOT NULL,
    "work_location" "work_location" NOT NULL,
    "company_id" INTEGER NOT NULL,
    "posted_by_recruiter_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN DEFAULT true,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "applications" (
    "application_id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "applicant_id" INTEGER NOT NULL,
    "applicant_email" VARCHAR(255) NOT NULL,
    "status" "application_status" NOT NULL DEFAULT 'Submitted',
    "resume" VARCHAR(255),
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subscribed" BOOLEAN,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "job_analytics" (
    "job_id" INTEGER NOT NULL,
    "date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "views" INTEGER NOT NULL DEFAULT 0,
    "applications" INTEGER NOT NULL DEFAULT 0,
    "status_changes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "job_analytics_pkey" PRIMARY KEY ("job_id","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- CreateIndex
CREATE UNIQUE INDEX "companies_name_key" ON "companies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "applications_job_id_applicant_id_key" ON "applications"("job_id", "applicant_id");

-- AddForeignKey
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("skill_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("company_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("job_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_analytics" ADD CONSTRAINT "job_analytics_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("job_id") ON DELETE CASCADE ON UPDATE NO ACTION;
