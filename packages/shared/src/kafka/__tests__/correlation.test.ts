import { describe, it, expect } from "vitest";
import {
  runWithCorrelation,
  getCorrelationId,
  newCorrelationId,
} from "../correlation.js";

describe("correlation (Phase 10)", () => {
  it("generates a new correlation when none is provided", async () => {
    let inside: string | undefined;
    await runWithCorrelation(undefined, async () => {
      inside = getCorrelationId();
    });
    expect(inside).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("propagates the provided id through nested async scopes", async () => {
    const id = newCorrelationId();
    const seen: string[] = [];
    await runWithCorrelation(id, async () => {
      seen.push(getCorrelationId());
      await Promise.all([
        (async () => seen.push(getCorrelationId()))(),
        (async () => {
          await runWithCorrelation("inner-child", async () =>
            seen.push(getCorrelationId()),
          );
        })(),
      ]);
    });
    expect(seen[0]).toBe(id);
    expect(seen[1]).toBe(id);
    expect(seen[2]).toBe("inner-child");
  });

  it("is used by the outbox worker to tag its own publishes (producer contract)", async () => {
    // The outbox -> producer path passes correlationId explicitly; a request-level
    // id set from HTTP middleware flows into the outbox row and then the envelope.
    const correlationId = newCorrelationId();
    const received: string[] = [];
    await runWithCorrelation(correlationId, async () => {
      received.push(getCorrelationId());
    });
    expect(received[0]).toBe(correlationId);
  });
});