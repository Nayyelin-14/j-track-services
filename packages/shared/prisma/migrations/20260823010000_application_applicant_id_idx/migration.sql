-- CreateIndex
-- Backs the hot "my applications" lookup (WHERE applicant_id = ...).
-- The existing unique([job_id, applicant_id]) index cannot serve it because
-- job_id is the leading column.
CREATE INDEX "applications_applicant_id_idx" ON "applications"("applicant_id");
