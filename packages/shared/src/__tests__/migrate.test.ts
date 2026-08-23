import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn((..._args: unknown[]) => Buffer.from(""));

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execMock(...(args as [])),
}));

const mockTxQueryRaw = vi.fn();
const mockTransaction = vi.fn(
  async (fn: (tx: unknown) => Promise<void>, _opts?: unknown) =>
    fn({
      $queryRaw: mockTxQueryRaw,
    }),
);

vi.mock("../db", () => ({
  prisma: { $transaction: mockTransaction },
}));

async function loadMigrate() {
  return import("../migrate.js");
}

describe("runMigrationsWithLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockReturnValue(Buffer.from(""));
  });

  it("runs migrate deploy after acquiring the advisory lock", async () => {
    mockTxQueryRaw.mockResolvedValue([{ locked: true }]);

    const { runMigrationsWithLock } = await loadMigrate();
    await runMigrationsWithLock("test-service");

    expect(mockTxQueryRaw).toHaveBeenCalledOnce();
    const sql = (mockTxQueryRaw.mock.calls[0] as unknown[])[0];
    expect(String(sql)).toContain("pg_try_advisory_xact_lock");
    expect(execMock).toHaveBeenCalledOnce();
    expect(String(execMock.mock.calls[0][0])).toContain("prisma migrate deploy");
  });

  it("polls until the lock becomes free instead of failing", async () => {
    // First two attempts: lock busy. Then acquired.
    mockTxQueryRaw
      .mockResolvedValueOnce([{ locked: false }])
      .mockResolvedValueOnce([{ locked: false }])
      .mockResolvedValue([{ locked: true }]);

    const { runMigrationsWithLock } = await loadMigrate();
    await runMigrationsWithLock("test-service");

    expect(mockTxQueryRaw).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenCalledOnce();
  });

  it("serializes concurrent migrators so only one runs deploy at a time", async () => {
    let lockHeld = false;
    let running = 0;
    let maxConcurrent = 0;

    mockTxQueryRaw.mockImplementation(async () => {
      if (lockHeld) return [{ locked: false }];
      lockHeld = true;
      return [{ locked: true }];
    });
    execMock.mockImplementation(() => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      // simulate a slow migration while holding the lock
      const until = Date.now() + 30;
      while (Date.now() < until) {
        /* busy wait */
      }
      running -= 1;
      lockHeld = false;
      return Buffer.from("");
    });

    const { runMigrationsWithLock } = await loadMigrate();
    await Promise.all([
      runMigrationsWithLock("svc-a"),
      runMigrationsWithLock("svc-b"),
      runMigrationsWithLock("svc-c"),
    ]);

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(maxConcurrent).toBe(1);
  });

  it("surfaces migration failure from inside the lock transaction", async () => {
    mockTxQueryRaw.mockResolvedValue([{ locked: true }]);
    execMock.mockImplementation(() => {
      throw new Error("deploy failed");
    });

    const { runMigrationsWithLock } = await loadMigrate();
    await expect(runMigrationsWithLock("test-service")).rejects.toThrow(
      "deploy failed",
    );

    // xact-scoped lock is released by the rollback; generous timeout kept so
    // slow cold starts don't kill the interactive transaction mid-migration.
    expect(mockTransaction).toHaveBeenCalledOnce();
    const opts = (mockTransaction.mock.calls[0] as unknown[])[1] as { timeout: number };
    expect(opts.timeout).toBeGreaterThanOrEqual(300_000);
  });
});
