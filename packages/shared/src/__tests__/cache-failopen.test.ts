import { describe, it, expect, vi } from "vitest";
import { withCache } from "../redis/helpers";

function makeClient(overrides: Partial<Record<"get" | "setEx", never>> = {}) {
  return {
    get: vi.fn(),
    setEx: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    eval: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof withCache>[0];
}

describe("withCache fail-open behavior", () => {
  it("serves from cache on hit without calling fetch", async () => {
    const client = makeClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ v: 1 }));
    const fetcher = vi.fn();

    const { data, fromCache } = await withCache(client, "k", 60, fetcher);

    expect(data).toEqual({ v: 1 });
    expect(fromCache).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls through to the database when the cache read fails (fail-open)", async () => {
    const client = makeClient();
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    (client.setEx as ReturnType<typeof vi.fn>).mockResolvedValue("OK");
    const fetcher = vi.fn().mockResolvedValue({ v: "from-db" });

    const { data, fromCache } = await withCache(client, "k", 60, fetcher);

    expect(data).toEqual({ v: "from-db" });
    expect(fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("still returns fresh data when the cache write fails after a miss", async () => {
    const client = makeClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (client.setEx as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("redis down"));
    const fetcher = vi.fn().mockResolvedValue({ v: 42 });

    const { data, fromCache } = await withCache(client, "k", 60, fetcher);

    expect(data).toEqual({ v: 42 });
    expect(fromCache).toBe(false);
  });

  it("ignores corrupt cached payloads and refetches", async () => {
    const client = makeClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue("{not-json");
    (client.setEx as ReturnType<typeof vi.fn>).mockResolvedValue("OK");
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    const { data, fromCache } = await withCache(client, "k", 60, fetcher);

    expect(data).toEqual({ ok: true });
    expect(fromCache).toBe(false);
  });
});
