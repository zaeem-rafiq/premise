// The model adapter: sends an MP1 request to the Workers AI binding and classifies
// the outcome by TL12's table. The binding comes in as an argument so a test hands
// a fake; `urlModel` builds the same shape over HTTP for tests that run the real
// Durable Object against a stand-in model service.
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

/** An HTTP-shaped transport failure, raised by `urlModel` and matched by Workers
 * AI's own error surface (the binding throws with `code`/`status`). */
export class ModelHttpError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly retryAfterMs: number | null;

  constructor(status: number, code: number | null, retryAfterMs: number | null, detail: string) {
    super(`model http ${status}${code === null ? "" : ` code ${code}`}: ${detail}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

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

/**
 * A stand-in binding over HTTP for workerd tests: `POST {base}/run` with
 * `{model, request}`, the response body is the raw provider answer. Non-2xx
 * answers carry `{code?, retry_after_ms?}` and throw `ModelHttpError`, which
 * `classifyModelError` maps the same way the real binding's errors map.
 */
export function urlModel(base: string): AiBinding {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  return {
    async run(model: string, request: Record<string, unknown>): Promise<unknown> {
      const res = await fetch(`${root}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, request }),
      });
      const text = await res.text();
      if (!res.ok) {
        let code: number | null = null;
        let retry: number | null = null;
        try {
          const j = JSON.parse(text) as { code?: number; retry_after_ms?: number };
          code = typeof j.code === "number" ? j.code : null;
          retry = typeof j.retry_after_ms === "number" ? j.retry_after_ms : null;
        } catch {
          // a plain body is fine
        }
        const header = res.headers.get("retry-after");
        if (retry === null && header !== null) {
          const secs = Number(header);
          if (Number.isFinite(secs)) retry = Math.ceil(secs * 1000);
        }
        throw new ModelHttpError(res.status, code, retry, text.slice(0, 200));
      }
      return JSON.parse(text);
    },
  };
}
