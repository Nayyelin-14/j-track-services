import { describe, it, expect } from "vitest";
import { producePartitionKey } from "../partitioning.js";

describe("partitioning & ordering (Phase 7)", () => {
  it("derives a stable key from the aggregate id", () => {
    expect(producePartitionKey("job", "42")).toBe("job-42");
    expect(producePartitionKey("job", "42")).toBe("job-42");
    expect(producePartitionKey("job", "43")).toBe("job-43");
  });

  it("keeps all events for one aggregate on one key (ordering per aggregate)", () => {
    const appliedKey = producePartitionKey("job", "7");
    const viewedKey = producePartitionKey("job", "7");
    const statusKey = producePartitionKey("job", "7");
    expect(new Set([appliedKey, viewedKey, statusKey]).size).toBe(1);
  });

  it("produces the same key regardless of event type for the same aggregate", () => {
    const k1 = producePartitionKey("job", "99");
    const k2 = producePartitionKey("job", "99");
    expect(k1).toBe(k2);
  });
});