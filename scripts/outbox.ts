import dotenv from "dotenv";
import { resolve } from "node:path";
import { prisma } from "@jtrack/shared/db";
import {
  findOutboxEvents,
  resetOutboxEvents,
} from "@jtrack/shared/kafka/outbox";

dotenv.config({ path: resolve(process.cwd(), ".env") });

type OutboxStatus = "PENDING" | "PROCESSING" | "SENT" | "FAILED";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      out[key] = value;
      if (value !== "true") i++;
    }
  }
  return out;
}

function usage(): void {
  console.log(`
outbox - inspect and retry transactional outbox events

Usage:
  tsx scripts/outbox.ts <command> [options]

Commands:
  list    Inspect outbox rows (default)
  retry   Reset FAILED (and optionally stale PROCESSING) rows back to PENDING

Options (list):
  --status <s>        Filter by status: PENDING|PROCESSING|SENT|FAILED (repeatable)
  --topic <topic>     Filter by topic (e.g. job-events, send-mail)
  --event-id <uuid>   Filter by a specific stable eventId
  --stale <ms>        Only PROCESSING rows claimed more than <ms> ago
  --older-than <ms>   Only rows created more than <ms> ago
  --limit <n>         Max rows to show (default: 100)

Options (retry):
  --statuses <s,...>  Statuses to reset (default: FAILED). Use FAILED,PROCESSING
                      to also reclaim stale PROCESSING claims.
  --event-id <uuid>   Reset a specific eventId
  --topic <topic>     Reset rows for a topic
  --limit <n>         Safety bound on rows reset

The original eventId is preserved on retry, so consumer-side idempotency
prevents duplicate business effects if a partially-applied event re-publishes.
`);
}

function statusFilter(values: string[]): OutboxStatus[] {
  const allowed = ["PENDING", "PROCESSING", "SENT", "FAILED"];
  return values.filter((v) => allowed.includes(v.toUpperCase())) as OutboxStatus[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const command = positionals[0] ?? "list";

  if (args["help"] === "true") {
    usage();
    process.exit(0);
  }

  const isRetry = command === "retry";

  if (!isRetry) {
    const statuses = statusFilter(
      [args["status"], args["statuses"]].filter(Boolean) as string[],
    );
    const rows = await findOutboxEvents(prisma, {
      status: statuses.length > 0 ? statuses : undefined,
      topic: args["topic"] !== "true" ? args["topic"] : undefined,
      eventId: args["event-id"] !== "true" ? args["event-id"] : undefined,
      staleOlderThanMs:
        args["stale"] !== "true" ? Number(args["stale"]) || undefined : undefined,
      olderThanMs:
        args["older-than"] !== "true" ? Number(args["older-than"]) || undefined : undefined,
      limit: Number(args["limit"]) || 100,
    });

    if (rows.length === 0) {
      console.log("[outbox] no rows match");
      process.exit(0);
    }

    console.log(`[outbox] ${rows.length} row(s):`);
    for (const r of rows) {
      console.log(
        [
          `#${r.id}`,
          r.status,
          r.topic,
          `eventId=${r.eventId}`,
          `attempts=${r.attempts}`,
          r.claimedBy ? `claimedBy=${r.claimedBy}` : "",
          r.lastError ? `lastError="${r.lastError.slice(0, 80)}"` : "",
        ]
          .filter(Boolean)
          .join("  "),
      );
    }
    process.exit(0);
  }

  const statuses = (args["statuses"] ?? "FAILED")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0) as OutboxStatus[];

  const { reset } = await resetOutboxEvents(prisma, {
    eventId: args["event-id"] !== "true" ? args["event-id"] : undefined,
    topic: args["topic"] !== "true" ? args["topic"] : undefined,
    statuses,
    limit: args["limit"] !== "true" ? Number(args["limit"]) || undefined : undefined,
  });

  console.log(`[outbox] reset ${reset} row(s) to PENDING`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[outbox] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});