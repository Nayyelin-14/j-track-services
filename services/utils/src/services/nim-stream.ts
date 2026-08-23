import AIConfig from "../config/ai.js";

/**
 * Shared NVIDIA NIM streaming execution used by Job Match Analysis and
 * Career AI. One place owns the production safety behavior:
 *
 *   - stream_options include_usage with automatic plain retry when a model
 *     rejects them (400/422)
 *   - system-role merge retry for models without system-role support,
 *     using a labeled single-user-message format that preserves the
 *     system / user / assistant boundaries instead of blind concatenation
 *   - token usage capture, wall-clock latency
 *   - hard per-call timeout + overall stream deadline + inter-chunk idle
 *     watchdog (a stream that stops producing chunks is aborted instead of
 *     hanging on transport-level timeouts)
 *   - reasoning deltas are captured for diagnostics but NEVER streamed to
 *     the caller; a response with no user-facing content is an error
 */

export const NIM_CALL_TIMEOUT_MS = 90_000;
export const STREAM_DEADLINE_MS = 120_000;
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.NIM_STREAM_IDLE_TIMEOUT_MS ?? 30_000);

export interface NimMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOutcome {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  latencyMs: number;
}

export interface RunStreamOptions {
  maxTokens?: number;
  temperature?: number;
  /** Overall wall-clock budget for the streamed response. */
  deadlineMs?: number;
  /** Max silence between stream chunks before the generation is aborted. */
  idleTimeoutMs?: number;
  /** Error thrown when the deadline is hit (kept configurable so each
   * feature surfaces its own wording, exactly as before extraction). */
  deadlineErrorMessage?: string;
}

/** The stream received headers but produced no chunks for too long. */
export class StreamStalledError extends Error {
  constructor(idleMs: number) {
    super(`No stream activity for ${idleMs}ms`);
    this.name = "StreamStalledError";
  }
}

/** The model finished without any user-facing answer content. */
export class EmptyResponseError extends Error {
  constructor() {
    super("Model returned no answer content");
    this.name = "EmptyResponseError";
  }
}

type ChatChunk = {
  choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

function isSystemRoleUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /system role not supported/i.test(message);
}

/**
 * Fallback format for models that reject the system role: every message is
 * folded into ONE user message behind explicit section headers, so the
 * model can still tell system instructions apart from conversation turns.
 */
export function mergeMessagesForSystemRoleHostileModels(messages: NimMessage[]): NimMessage[] {
  const label: Record<NimMessage["role"], string> = {
    system: "SYSTEM INSTRUCTIONS",
    user: "USER MESSAGE",
    assistant: "ASSISTANT MESSAGE",
  };

  const merged = messages
    .map((m) => `=== ${label[m.role]} ===\n${m.content}`)
    .join("\n\n");
  return [{ role: "user", content: merged }];
}

/**
 * Run one streamed NIM completion. Streams user-facing text chunks via
 * onText and returns the aggregated output plus real token usage and
 * latency. Aborts when the caller signal fires, the overall deadline is
 * exceeded, or no chunk arrives within the idle window.
 */
export async function runNimStream(
  model: string,
  messages: NimMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
  options: RunStreamOptions = {},
): Promise<StreamOutcome> {
  const ai = AIConfig.getInstance();
  const startedAt = Date.now();
  const deadline = startedAt + (options.deadlineMs ?? STREAM_DEADLINE_MS);
  const deadlineErrorMessage = options.deadlineErrorMessage ?? "Analysis exceeded time limit";
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;

  // Upstream requests listen to this controller; both the caller's signal
  // and the idle watchdog funnel into it.
  const upstream = new AbortController();
  const onCallerAbort = () => upstream.abort();
  if (signal.aborted) onCallerAbort();
  else signal.addEventListener("abort", onCallerAbort, { once: true });

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const armIdleWatchdog = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      upstream.abort();
    }, idleTimeoutMs);
  };
  const disarmIdleWatchdog = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const createWith = (
    useModel: string,
    useMessages: NimMessage[],
    includeUsage: boolean,
  ) =>
    ai.chat.completions.create(
      {
        model: useModel,
        messages: useMessages,
        max_tokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      },
      { timeout: NIM_CALL_TIMEOUT_MS, signal: upstream.signal },
    );

  try {
    let stream: AsyncIterable<ChatChunk>;
    try {
      stream = (await createWith(model, messages, true)) as AsyncIterable<ChatChunk>;
    } catch (err) {
      const status = (err as { status?: number }).status;
      // Some catalog models reject stream_options outright; retry plain once.
      if ((status === 400 || status === 422) && !isSystemRoleUnsupported(err)) {
        stream = (await createWith(model, messages, false)) as AsyncIterable<ChatChunk>;
      } else if (isSystemRoleUnsupported(err)) {
        // Model rejects the system role — retry with a labeled merged message.
        stream = (await createWith(
          model,
          mergeMessagesForSystemRoleHostileModels(messages),
          true,
        )) as AsyncIterable<ChatChunk>;
      } else {
        throw err;
      }
    }

    let content = "";
    let reasoning = "";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    armIdleWatchdog();
    try {
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("Request aborted");
        if (Date.now() > deadline) throw new Error(deadlineErrorMessage);
        armIdleWatchdog(); // any chunk (even usage-only) proves liveness

        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens ?? usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens ?? usage.total_tokens,
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        const piece = delta?.content || "";
        // Reasoning deltas are internal model work — never shown to users.
        const reasoningPiece = delta?.reasoning || delta?.reasoning_content || "";
        if (piece) {
          content += piece;
          onText(piece);
        } else if (reasoningPiece) {
          reasoning += reasoningPiece;
        }
      }
    } catch (err) {
      // Aborting a stalled stream makes the iterator throw — classify it.
      if (stalled) throw new StreamStalledError(idleTimeoutMs);
      throw err;
    } finally {
      disarmIdleWatchdog();
    }

    if (stalled) throw new StreamStalledError(idleTimeoutMs);

    // A client disconnect can surface as a clean iterator end (not a throw)
    // while partial content has already accumulated — never report that as
    // success. Re-throw the signal's own abort reason.
    if (signal.aborted) signal.throwIfAborted();
    else if (upstream.signal.aborted) upstream.signal.throwIfAborted();

    const text = content.trim();
    if (!text) {
      // Reasoning-only or empty completions are not answers — surface as a
      // failure so the caller can fall back while nothing has been streamed.
      throw new EmptyResponseError();
    }

    return { text, usage, latencyMs: Date.now() - startedAt };
  } finally {
    disarmIdleWatchdog();
    signal.removeEventListener("abort", onCallerAbort);
  }
}
