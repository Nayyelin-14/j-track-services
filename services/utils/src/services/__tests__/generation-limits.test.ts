import { describe, it, expect, beforeEach } from "vitest";
import { GenerationLimits, MAX_ACTIVE_CAREER_GENERATIONS } from "../generation-limits";

describe("GenerationLimits", () => {
  let limits: GenerationLimits;

  beforeEach(() => {
    limits = new GenerationLimits();
  });

  it("allows one generation per user", () => {
    expect(limits.tryAcquire(1)).toBe("ok");
  });

  it("rejects a second concurrent generation for the same user without touching global capacity", () => {
    expect(limits.tryAcquire(7)).toBe("ok");
    expect(limits.tryAcquire(7)).toBe("user_busy");
    expect(limits.stats().active).toBe(1);
  });

  it("keeps other users unaffected by one user's active slot", () => {
    expect(limits.tryAcquire(1)).toBe("ok");
    expect(limits.tryAcquire(2)).toBe("ok");
    expect(limits.tryAcquire(1)).toBe("user_busy");
  });

  it("rejects beyond the global ceiling with at_capacity", () => {
    for (let id = 1; id <= MAX_ACTIVE_CAREER_GENERATIONS; id++) {
      expect(limits.tryAcquire(id)).toBe("ok");
    }
    expect(limits.stats()).toEqual({ active: MAX_ACTIVE_CAREER_GENERATIONS, max: MAX_ACTIVE_CAREER_GENERATIONS });
    expect(limits.tryAcquire(10_001)).toBe("at_capacity");
  });

  it("releases the slot on every termination path (idempotent)", () => {
    limits.tryAcquire(5);
    limits.release(5);
    expect(limits.stats().active).toBe(0);
    expect(limits.tryAcquire(5)).toBe("ok");

    // Double release must not corrupt the counter.
    limits.release(5);
    expect(limits.stats().active).toBe(0);
  });

  it("frees capacity immediately after release so the next user proceeds", () => {
    for (let id = 1; id <= MAX_ACTIVE_CAREER_GENERATIONS; id++) limits.tryAcquire(id);
    expect(limits.tryAcquire(99)).toBe("at_capacity");
    limits.release(3);
    expect(limits.tryAcquire(99)).toBe("ok");
  });
});
