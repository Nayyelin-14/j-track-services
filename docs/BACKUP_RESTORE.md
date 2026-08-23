# J-Track Database Backup & Restore Strategy

Status legend:
- **VERIFIED** — confirmed against the actual system described in this repo.
- **REQUIRES CLOUD CONFIGURATION** — must be set up in the provider console / VM cron; cannot be verified from this repository.

## 1. Production database

| Item | Value |
|---|---|
| Provider | [Neon](https://neon.tech) serverless PostgreSQL |
| Identification | `DB_URL` env var (`.env`, **never committed**) — currently `ep-billowing-mode-aoe6lluk-pooler...aws.neon.tech/neondb` |
| Access path | Prisma (`packages/shared/prisma/schema.prisma`), pooled connection |
| SSL | Required by Neon endpoint (`sslmode=require`) — **VERIFIED** in connection string |
| Migrations | `prisma migrate deploy` run at auth-service startup under a transaction-scoped Postgres advisory lock (`runMigrationsWithLock`, `pg_try_advisory_xact_lock` + bounded wait) — **VERIFIED** |

> ⚠️ The `-pooler` endpoint uses PgBouncer. Session-level features (advisory locks,
> cursors) can behave unexpectedly through it. Migrations already use an advisory
> lock; if migration lock timeouts appear, run them against the *unpooled* Neon
> endpoint.

## 2. What is verifiable from this repository

- Connection topology and credentials location (**VERIFIED**, `.env` is git-ignored).
- Schema + migration history in `packages/shared/prisma/migrations` — the schema can always be rebuilt from migrations alone.
- No backup jobs exist anywhere in the repos (**VERIFIED**: no pg_dump/cron/CI backup workflow found). This document defines the required setup; it is not yet implemented.

## 3. Backup mechanisms

### 3.1 Provider-side snapshots (REQUIRES NEON CONSOLE CONFIGURATION)
Neon provides point-in-time restore (PITR) and branch-based backups on paid tiers.
Required manual configuration:

1. In the Neon console, confirm the project's **history/PITR retention window**
   (recommend ≥ 7 days).
2. Record who owns the Neon project (billing owner + a second admin) so backups
   are recoverable if one person is unavailable.
3. Do **not** rely on branches for backups unless a scheduled snapshot branch is
   created — branches are mutable like the main DB.

### 3.2 Logical dumps via `pg_dump` (REQUIRES VM/CI CRON SETUP)
Daily logical dump, independent of the provider:

```bash
# Run on Azure VM (or GitHub Actions cron). DB_URL comes from the secret store,
# never from the repository.
pg_dump "$DB_URL" \
  --format=custom \          # -Fc: compressed, supports selective restore
  --no-owner --no-privileges \
  --file "jtrack_$(date -u +%Y%m%d_%H%M%S).dump"
```

Recommended schedule and retention:

| Layer | Frequency | Retention | Storage |
|---|---|---|---|
| Full custom dump | daily 03:00 UTC | 14 daily, 8 weekly | Azure Blob Storage, **private container, SSE enabled** |
| Pre-migration dump | automatic, before each deploy | 30 days | same |
| Neon PITR | continuous | ≥ 7 days | Neon-managed |

Upload with SAS token or workload-identity auth; bucket/container must NOT be public.

## 4. RPO / RTO targets

| Metric | Target | Rationale |
|---|---|---|
| RPO | ≤ 24 h (dumps) / ≤ 5 min (Neon PITR) | job-application data changes slowly; PITR covers tighter needs if configured |
| RTO | ≤ 2 h | restore into a fresh Neon branch/database + point app `DB_URL` at it |

## 5. Restore procedure

1. Provision target: create a new Neon **branch** (or empty database).
2. Restore dump:
   ```bash
   pg_restore --dbname="$TARGET_DB_URL" \
     --no-owner --no-privileges --jobs=4 jtrack_YYYYMMDD_HHMMSS.dump
   ```
   (For plain-SQL dumps: `psql "$TARGET_DB_URL" < dump.sql`.)
3. Run `npx prisma migrate deploy` against the target to confirm schema parity
   (should report "No pending migrations").
4. Smoke-check row counts:
   ```sql
   SELECT 'users', count(*) FROM "users"
   UNION ALL SELECT 'companies', count(*) FROM companies
   UNION ALL SELECT 'jobs', count(*) FROM jobs
   UNION ALL SELECT 'applications', count(*) FROM applications;
   ```
5. Point the backend `DB_URL` at the restored target (update the secret, redeploy/restart services).

## 6. Restore verification checklist

- [ ] `prisma migrate deploy` reports no pending migrations on the restored DB
- [ ] Row counts match source (or expected PITR state) for users/companies/jobs/applications
- [ ] Login works for a known test account against a service pointed at the restore
- [ ] Creating a company + job + application succeeds end-to-end
- [ ] Application status update persists
- [ ] No foreign-key orphans (`applications` rows without matching `jobs`)
- [ ] Restore time recorded; compare against RTO target

## 7. Disaster recovery procedure

1. Declare data-loss window using last verified dump / PITR target.
2. Restore latest dump into `neondb-restore` branch (per §5).
3. If recovering from partial failure, replay nothing — the app has no write-ahead
   queues that survive restarts except Kafka mail events (transient, safe to lose;
   DLQ topic `send-mail-dlq` holds failed mails).
4. Re-point services via `DB_URL`; restart auth → user → jobs → utils.
5. Keep the broken database intact until sign-off (forensics / rollback).

## 8. Safe restore drill (do this quarterly)

Use a **throwaway Neon branch** — never production:

```bash
# Neon branch URL (from console), NOT the production DB_URL
pg_restore --dbname="$BRANCH_DB_URL" --no-owner --jobs=4 latest.dump
# then run the §6 checklist with a temporary backend deployment pointed at the branch
```

Local alternative: `docker run -e POSTGRES_PASSWORD=drill postgres:16` +
`pg_restore` into it. Delete the branch/container after recording results.

## 9. Migration considerations

- Every deploy runs `migrate deploy` automatically (auth startup, advisory-lock guarded).
- Take a manual pre-deploy dump before migrations that drop/alter columns.
- Migrations are forward-only; rollback = restore pre-migration dump into a branch
  and re-point.

## 10. Ownership

| Role | Responsibility |
|---|---|
| Backend owner | maintains cron/CI dump job, rotation, and this document |
| Neon project admin | PITR retention config, access control |
| On-call operator | executes §5/§7 during incidents, records RTO achieved |

---

*Implementation of the cron/GitHub Action dump job is tracked as infrastructure
work outside this repository.*
