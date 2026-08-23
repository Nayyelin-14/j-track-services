import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request-level correlation ID propagation using Node's AsyncLocalStorage.
 * The correlationId is set once per HTTP request (by middleware) and flows
 * through: business operation -> outbox row -> Kafka envelope -> consumer ->
 * downstream logs. Consumers run each message handler inside a context so
 * their logs carry the same correlationId that the originating request had.
 */

interface CorrelationContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function runWithCorrelation<T>(
  correlationId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    correlationId ? { correlationId } : { correlationId: newCorrelationId() },
    fn,
  );
}

export function runWithCorrelationSync<T>(correlationId: string | undefined, fn: () => T): T {
  return storage.run(
    correlationId ? { correlationId } : { correlationId: newCorrelationId() },
    fn,
  );
}

/** Returns the current correlationId or generates one if none is set. */
export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}

/** Returns undefined when no correlation context is active. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Express middleware: adopt inbound x-correlation-id or mint a new one. */
export function correlationMiddleware() {
  return (
    req: { headers: Record<string, string | string[] | undefined> },
    _res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ) => {
    const header = req.headers["x-correlation-id"];
    const incoming = Array.isArray(header) ? header[0] : header;
    const correlationId = incoming && incoming.trim().length > 0 ? incoming.trim() : newCorrelationId();
    _res.setHeader("x-correlation-id", correlationId);
    storage.run({ correlationId }, () => next());
  };
}