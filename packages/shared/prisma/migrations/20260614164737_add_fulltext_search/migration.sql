-- AlterEnum
ALTER TYPE "application_status" ADD VALUE IF NOT EXISTS 'Applied';

-- AlterTable: fix default from Submitted to Applied
ALTER TABLE "applications" ALTER COLUMN "status" SET DEFAULT 'Applied';

-- GIN indexes for full-text search
CREATE INDEX IF NOT EXISTS idx_users_search ON "users" USING GIN("search_vector");
CREATE INDEX IF NOT EXISTS idx_companies_search ON "companies" USING GIN("search_vector");

-- Trigger function for user search vector
CREATE OR REPLACE FUNCTION update_user_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.bio, '')), 'C') ||
    COALESCE(
      (SELECT setweight(to_tsvector('english', string_agg(s.name, ' ')), 'C')
       FROM user_skills us JOIN skills s ON us.skill_id = s.skill_id
       WHERE us.user_id = NEW.user_id),
      to_tsvector('')
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_search ON "users";
CREATE TRIGGER trg_users_search
  BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION update_user_search_vector();

-- Trigger function for company search vector
CREATE OR REPLACE FUNCTION update_company_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.location, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_companies_search ON "companies";
CREATE TRIGGER trg_companies_search
  BEFORE INSERT OR UPDATE ON "companies"
  FOR EACH ROW EXECUTE FUNCTION update_company_search_vector();

-- Compound index for notification lookups (created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS idx_notifications_lookup ON "notifications"("user_id", "created_at" DESC, "id" DESC);
