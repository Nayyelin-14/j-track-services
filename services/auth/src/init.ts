import { runMigrationsWithLock } from "@jtrack/shared/migrate";

export async function initDB() {
  await runMigrationsWithLock("auth");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initDB()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[DB] Auth schema initialization failed:", err);
      process.exit(1);
    });
}
