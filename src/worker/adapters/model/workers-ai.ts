// The model adapter: sends an MP1 request to the Workers AI binding and classifies
// the outcome by TL12's table. The binding comes in as an argument so a test hands
// a fake with the same surface (a service binding's `run`, for the workerd tests).
// Source: 05-agent MP1, TL12 to TL14; 01-core SE8.

export const MODEL_TIMEOUT_MS = 60_000;

/** The piece of the Workers AI binding this adapter uses. `env.AI` satisfies it;
 * a test passes a fake with the same surface. */
export interface AiBinding {
  run(model: string, request: Record<string, unknown>): Promise<unknown>;
}

/** What the provider answered, classified. `answer` carries the raw result for the
 * pure `parseModelAnswer`; every other kind maps onto one TL12 failure line. */
export type ModelOutcome =
  | { kind: "answer"; result: unknown }
  | { kind: "rate_limited"; retry_after_ms: number | null }
  | { kind: "rejected" }
  | { kind: "unavailable" }
  | { kind: "timeout" };

/** Classify a thrown value by TL12's table: HTTP 429 or code 3040 is a rate
 * limit; 5xx, 3007 or 3008, and transport failures are `unavailable`; any other
 * 4xx is `rejected`. */
export function classifyModelError(error: unknown): ModelOutcome {
  const status =
    typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
      ? ((error as { status: number }).status as number)
      : typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number"
        ? ((error as { code: number }).code as number)
        : null;
  const retry =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? ((error as { retryAfterMs: number }).retryAfterMs as number)
      : null;
  if (status === 429 || status === 3040) return { kind: "rate_limited", retry_after_ms: retry };
  if (status === 3007 || status === 3008 || (status !== null && status >= 500)) return { kind: "unavailable" };
  if (status !== null && status >= 400 && status < 500) return { kind: "rejected" };
  return { kind: "unavailable" }; // transport failure: no usable status
}

/**
 * Send one MP1 request. The time-out is ours, not the binding's: after
 * `timeoutMs` the call answers `timeout` and the late provider answer is
 * ignored (TL12). A thrown binding error is classified, never re-raised.
 */
export async function callModel(
  ai: AiBinding,
  model: string,
  request: Record<string, unknown>,
  timeoutMs: number = MODEL_TIMEOUT_MS,
): Promise<ModelOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const deadline = new Promise<ModelOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    const sent = ai.run(model, request).then(
      (result): ModelOutcome => ({ kind: "answer", result }),
      (error): ModelOutcome => classifyModelError(error),
    );
    return await Promise.race([sent, deadline]);
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
