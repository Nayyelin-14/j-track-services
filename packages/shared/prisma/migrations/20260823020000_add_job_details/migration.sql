-- Backfill missing migration: "details" existed in the Prisma schema but had
-- no migration, so fresh databases (migrate deploy) lacked the column while
-- the dev database had it out-of-band. Caught by fresh-DB E2E.
ALTER TABLE "jobs" ADD COLUMN "details" JSONB;
