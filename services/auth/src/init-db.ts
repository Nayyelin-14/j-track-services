import "dotenv/config";
import { sql } from "@jtrack/shared/db";

async function initDB() {
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('jobseeker', 'recruiter');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_type') THEN
        CREATE TYPE job_type AS ENUM ('Full-time', 'Part-time', 'Contract', 'Internship');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_location') THEN
        CREATE TYPE work_location AS ENUM ('On-site', 'Remote', 'Hybrid');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_status') THEN
        CREATE TYPE application_status AS ENUM ('Applied', 'Submitted', 'Rejected', 'Hired');
      END IF;
    END $$;
  `;

  await sql`ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'Applied'`;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      role user_role NOT NULL,
      bio TEXT,
      resume VARCHAR(255),
      refresh_token TEXT,
      resume_public_id VARCHAR(255),
      profile_pic VARCHAR(255),
      profile_pic_public_id VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      subscription TIMESTAMPTZ
    );
  `;

  await sql`
    ALTER TABLE users
    DROP COLUMN IF EXISTS reset_token,
    DROP COLUMN IF EXISTS reset_token_expires,
    DROP COLUMN IF EXISTS reset_token_attempts,
    DROP COLUMN IF EXISTS reset_token_locked_until;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS skills (
      skill_id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      skill_id INTEGER REFERENCES skills(skill_id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, skill_id)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS companies (
      company_id     SERIAL PRIMARY KEY,
      name           VARCHAR(255) NOT NULL UNIQUE,
      description    TEXT NOT NULL,
      website        VARCHAR(255) NOT NULL,
      location       VARCHAR(255),
      logo           VARCHAR(255),
      logo_public_id VARCHAR(255),
      recruiter_id   INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    ALTER TABLE companies
    ALTER COLUMN logo DROP NOT NULL,
    ALTER COLUMN logo_public_id DROP NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id                 SERIAL PRIMARY KEY,
      title                  VARCHAR(255) NOT NULL,
      description            TEXT NOT NULL,
      salary                 NUMERIC(10,2),
      location               VARCHAR(255),
      job_type               job_type NOT NULL,
      openings               NUMERIC(3,1) NOT NULL,
      role                   VARCHAR(255) NOT NULL,
      work_location          work_location NOT NULL,
      company_id             INTEGER NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
      posted_by_recruiter_id INTEGER NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active              BOOLEAN DEFAULT true
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS applications (
      application_id  SERIAL PRIMARY KEY,
      job_id          INTEGER NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      applicant_id    INTEGER NOT NULL,
      applicant_email VARCHAR(255) NOT NULL,
      status          application_status NOT NULL DEFAULT 'Applied',
      resume          VARCHAR(255),
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      subscribed      BOOLEAN,
      UNIQUE (job_id, applicant_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS job_analytics (
      job_id          INTEGER NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      date            DATE NOT NULL DEFAULT CURRENT_DATE,
      views           INTEGER NOT NULL DEFAULT 0,
      applications    INTEGER NOT NULL DEFAULT 0,
      status_changes  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, date)
    )
  `;

  console.log("[DB] Schema initialized");
}

initDB()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[DB] Schema initialization failed:", err);
    process.exit(1);
  });
