-- Salary stored as text so range values like "1000-2000" round-trip exactly.
-- Existing DECIMAL values are converted to their canonical string form.
ALTER TABLE "jobs" ALTER COLUMN "salary" TYPE VARCHAR(64) USING "salary"::text;
