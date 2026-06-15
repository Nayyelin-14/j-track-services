import { execSync } from "child_process";
import path from "path";
import fs from "fs";

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
      env: { ...process.env, DB_URL: process.env.DB_URL! },
    });
    console.log(`[${service}] Prisma migrations applied`);
  } catch (err) {
    console.error(`[${service}] Prisma migration failed:`, err);
    throw err;
  }
}

export async function runMigrationsWithLock(service: string) {
  return runMigrations(service);
}
