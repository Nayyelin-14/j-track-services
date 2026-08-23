import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { prisma } from "./db";

function getShell(): string {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  for (const sh of ["/usr/bin/sh", "/bin/sh", "/usr/bin/bash", "/bin/bash"]) {
    if (fs.existsSync(sh)) return sh;
  }
  return "sh";
}

export async function runMigrations(service: string) {
  try {
    execSync("npx prisma migrate deploy", {
      cwd: path.resolve(__dirname, "..", "prisma"),
      stdio: "inherit",
      shell: getShell(),
      env: { ...process.env, DB_URL: migrationDatabaseUrl() },
    });
    console.log(`[${service}] Prisma migrations applied`);
  } catch (err) {
    console.error(`[${service}] Prisma migration failed:`, err);
    throw err;
  }
}

/**
 * Database URL used ONLY for running migrations.
 *
 * `prisma migrate` takes an internal SESSION-scoped Postgres advisory lock.
 * Through Neon's "-pooler" endpoint (PgBouncer in transaction mode) such a
 * session lock can leak into the pool when a migrator exits, after which every
 * later `migrate deploy` fails with P1002 ("timed out trying to acquire a
 * postgres advisory lock") until the pooled connection is recycled.
 * Migrations therefore always target the direct endpoint. Override with
 * MIGRATE_DB_URL for non-Neon setups where pooling needs custom handling.
 */
export function migrationDatabaseUrl(): string {
  const explicit = process.env.MIGRATE_DB_URL;
  if (explicit) return explicit;
  const url = process.env.DB_URL!;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("-pooler.")) {
      parsed.hostname = parsed.hostname.replace("-pooler.", ".");
      return parsed.toString();
    }
  } catch {
    // fall through — let Prisma surface an invalid URL
  }
  return url;
}

/**
 * App-specific advisory-lock key. Any value works as long as every service
 * that migrates this database uses the same one.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 721100001;

/** How long a caller waits for another migrator to finish before giving up. */
const LOCK_WAIT_TIMEOUT_MS = 120_000;

const LOCK_POLL_INTERVAL_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `prisma migrate deploy` under a Postgres transaction-scoped advisory
 * lock so concurrent cold starts (e.g. auth/user/jobs/utils containers coming
 * up together, or multiple replicas of the migrating service) serialize
 * instead of racing inside `prisma migrate`.
 *
 * The lock is acquired with pg_try_advisory_xact_lock inside a single
 * interactive transaction:
 *   - it is released automatically at commit/rollback, even on crash;
 *   - it is safe through PgBouncer/Neon pooler in transaction mode, because
 *     all statements of one transaction share the same server session.
 *
 * Startup order remains "migrate once, then listen" — no fixed delays.
 * Only ONE service runs migrations by design (auth, see services/auth/src/init.ts);
 * this lock additionally makes that safe under replication/restarts.
 * The migrate deploy child itself runs against the DIRECT database endpoint
 * (see migrationDatabaseUrl) so its internal session lock cannot leak into
 * the pooler.
 */
export async function runMigrationsWithLock(service: string) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  await prisma.$transaction(
    async (tx) => {
      // Bounded wait for the lock — poll with pg_try_advisory_xact_lock.
      for (;;) {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${MIGRATION_ADVISORY_LOCK_KEY}) AS locked`;
        if (rows[0]?.locked === true) break;
        if (Date.now() > deadline) {
          throw new Error(
            `[${service}] Migration lock not acquired within ${LOCK_WAIT_TIMEOUT_MS}ms`,
          );
        }
        console.log(
          `[${service}] Migration lock busy, waiting ${LOCK_POLL_INTERVAL_MS}ms...`,
        );
        await sleep(LOCK_POLL_INTERVAL_MS);
      }

      console.log(`[${service}] Migration lock acquired, running migrate deploy`);
      await runMigrations(service);
    },
    // The transaction is held open while migrations run; allow slow cold starts.
    { timeout: 300_000, maxWait: 10_000 },
  );
}
