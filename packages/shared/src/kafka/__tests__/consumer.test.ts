import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchOffsetsMock = vi.fn();
const fetchTopicOffsetsMock = vi.fn();

vi.mock("kafkajs", () => {
  return {
    Kafka: class {
      constructor(private clientId: string) {}
      admin() {
        return {
          connect: async () => {},
          disconnect: async () => {},
          fetchOffsets: fetchOffsetsMock,
          fetchTopicOffsets: fetchTopicOffsetsMock,
        };
      }
    },
  };
});

import { getConsumerLag } from "../consumer.js";

beforeEach(() => {
  fetchOffsetsMock.mockReset();
  fetchTopicOffsetsMock.mockReset();
});

describe("getConsumerLag (real broker offsets, mocked admin)", () => {
  it("lag = high watermark minus committed offset per partition", async () => {
    fetchOffsetsMock.mockResolvedValue([
      { topic: "job-events", partitions: [{ partition: 0, offset: "5" }, { partition: 1, offset: "7" }] },
    ]);
    fetchTopicOffsetsMock.mockResolvedValueOnce([
      { partition: 0, offset: "10", low: "0", high: "10" },
      { partition: 1, offset: "12", low: "0", high: "12" },
    ]);

    const result = await getConsumerLag("analytics", "job-analytics-group", ["job-events"]);
    expect(result).toBeDefined();
    expect(result!.totalLag).toBe(10); // (10-5) + (12-7)
    expect(result!.topics[0]).toMatchObject({ partition: 0, committedOffset: 5, endOffset: 10, lag: 5, hasCommittedOffset: true });
    expect(result!.topics[1]).toMatchObject({ partition: 1, lag: 5, hasCommittedOffset: true });
  });

  it("no committed offset (-1) -> hasCommittedOffset false, lag = full partition length", async () => {
    fetchOffsetsMock.mockResolvedValue([
      { topic: "job-events", partitions: [{ partition: 0, offset: "-1" }] },
    ]);
    fetchTopicOffsetsMock.mockResolvedValueOnce([
      { partition: 0, offset: "42", low: "0", high: "42" },
    ]);

    const result = await getConsumerLag("analytics", "fresh-group", ["job-events"]);
    expect(result!.topics[0]).toMatchObject({ committedOffset: 0, endOffset: 42, lag: 42, hasCommittedOffset: false });
  });

  it("caught up consumer -> lag 0", async () => {
    fetchOffsetsMock.mockResolvedValue([
      { topic: "job-events", partitions: [{ partition: 0, offset: "10" }] },
    ]);
    fetchTopicOffsetsMock.mockResolvedValueOnce([
      { partition: 0, offset: "10", low: "0", high: "10" },
    ]);

    const result = await getConsumerLag("analytics", "caught-up", ["job-events"]);
    expect(result!.topics[0].lag).toBe(0);
    expect(result!.totalLag).toBe(0);
  });

  it("empty partition -> lag 0", async () => {
    fetchOffsetsMock.mockResolvedValue([
      { topic: "job-events", partitions: [{ partition: 0, offset: "-1" }] },
    ]);
    fetchTopicOffsetsMock.mockResolvedValueOnce([
      { partition: 0, offset: "0", low: "0", high: "0" },
    ]);

    const result = await getConsumerLag("analytics", "empty", ["job-events"]);
    expect(result!.topics[0].lag).toBe(0);
    expect(result!.topics[0].hasCommittedOffset).toBe(false);
  });

  it("returns undefined when the broker query fails (graceful degradation)", async () => {
    fetchOffsetsMock.mockRejectedValue(new Error("coordinator not available"));
    const result = await getConsumerLag("analytics", "g", ["job-events"]);
    expect(result).toBeUndefined();
  });
});