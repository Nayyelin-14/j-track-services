import dotenv from "dotenv";
import { resolve } from "node:path";
import { Kafka } from "kafkajs";
import { resolveKafkaConfig } from "@jtrack/shared/kafka/config";
import { replayFromDlq } from "@jtrack/shared/kafka/replay";

dotenv.config({ path: resolve(process.cwd(), ".env") });

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
kafka-replay - replay dead-lettered Kafka messages to their original topics

Usage:
  tsx scripts/kafka-replay.ts [options]

Options:
  --dlq-topic <topic>       DLQ topic to read from (default: send-mail-dlq)
  --consumer-id <id>        Only replay records for this consumer (e.g. mail-service)
  --original-topic <topic>  Only replay records originally destined for this topic
  --limit <n>               Max messages to replay (0 = until end of partition)
  --group-id <id>           Replay consumer group (default: kafka-replay)

The original eventId is preserved so idempotent consumers do not create
duplicate business effects on replay.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args["help"] === "true") {
    usage();
    process.exit(0);
  }

  const dlqTopic = args["dlq-topic"] ?? process.env.KAFKA_DLQ_TOPIC ?? "send-mail-dlq";
  const groupId = args["group-id"] ?? "kafka-replay";
  const limit = args["limit"] === "true" ? 0 : Number(args["limit"]) || 0;

  const kafka = new Kafka(resolveKafkaConfig("kafka-replay-cli"));
  const result = await replayFromDlq({
    kafka,
    dlqTopic,
    consumerId: args["consumer-id"] ?? undefined,
    originalTopic: args["original-topic"] ?? undefined,
    limit,
    groupId,
  });

  console.log(
    `[kafka-replay] done. read=${result.read} replayed=${result.replayed} ` +
      `skipped=${result.skipped} invalid=${result.invalid}`,
  );
  process.exit(result.replayed === 0 ? 0 : 0);
}

main().catch((err) => {
  console.error("[kafka-replay] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
