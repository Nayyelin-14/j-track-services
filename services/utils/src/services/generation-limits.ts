/**
 * In-memory generation capacity guards for Career AI.
 *
 * These are CONCURRENCY limits, not queues: acquisition is immediate and
 * either succeeds or rejects — nothing waits. Both structures are
 * process-local, which matches the current single-instance deployment.
 */

/** Global ceiling for simultaneously running Career AI generations. */
export const MAX_ACTIVE_CAREER_GENERATIONS = Number(
  process.env.MAX_ACTIVE_CAREER_GENERATIONS ?? 20,
);

export type AcquireResult = "ok" | "user_busy" | "at_capacity";

export class GenerationLimits {
  private activeUsers = new Set<number>();
  private activeGlobal = 0;

  /** One active generation per user; bounded total. */
  tryAcquire(userId: number): AcquireResult {
    if (this.activeUsers.has(userId)) return "user_busy";
    if (this.activeGlobal >= MAX_ACTIVE_CAREER_GENERATIONS) return "at_capacity";
    this.activeUsers.add(userId);
    this.activeGlobal += 1;
    return "ok";
  }

  /** Idempotent release — safe to call from every termination path. */
  release(userId: number): void {
    if (this.activeUsers.delete(userId)) {
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    }
  }

  stats(): { active: number; max: number } {
    return { active: this.activeGlobal, max: MAX_ACTIVE_CAREER_GENERATIONS };
  }
}

export const careerGenerationLimits = new GenerationLimits();
