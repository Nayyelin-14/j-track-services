import fs from "fs";
import path from "path";
import dotenv from "dotenv";

function findRootEnvPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function loadEnv(): void {
  const envPath = findRootEnvPath();
  if (envPath) {
    dotenv.config({ path: envPath, quiet: true });
  }
}