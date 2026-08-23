-- Backfill missing migration: "details" existed in the Prisma schema but had
-- no migration, so fresh databases (migrate deploy) lacked the column while
-- the dev database had it out-of-band. Caught by fresh-DB E2E.
-- IF NOT EXISTS keeps this idempotent for databases that already have it.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "details" JSONB;
