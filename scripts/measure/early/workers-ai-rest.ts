// The REST adapter of the early variant (ME1): the binding shape of MP1 over the Cloudflare REST
// API, `POST /client/v4/accounts/{account}/ai/run/{model}`. Credentials come from the environment
// (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`), pass through `redact()`, and are never written.
// `fetch` is injected so the tests use a fake and no credential ever leaves this process.

import { redact } from "../../../src/protocol/redact.ts";
import { MODEL_TIMEOUT_MS } from "../../../src/protocol/constants.ts";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export type RestOutcome =
  | { kind: "answer"; result: unknown } // `result` of the envelope, parsed by TL3
  | { kind: "rate_limited"; retry_after_ms: number }
  | { kind: "unavailable"; status: number; detail: string }
  | { kind: "rejected"; status: number; detail: string } // other 4xx: repeating cannot help (TL12)
  | { kind: "timeout" }
  | { kind: "network"; detail: string };

export const REST_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** The URL of one model call: the account and the model id as it stands in the plan. */
export function endpointOf(accountId: string, model: string): string {
  return `${REST_BASE}/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

const RATE_LIMIT_CODES = new Set([3040]);
const UNAVAILABLE_CODES = new Set([3007, 3008]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The Cloudflare error codes of a non-2xx or `success:false` body. */
function errorCodes(body: string): number[] {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown }> };
    return (parsed.errors ?? []).map((e) => Number(e.code)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function resultOf(body: string): unknown {
  const parsed = JSON.parse(body) as { result?: unknown };
  return parsed.result;
}

/**
 * One model call over REST (TL12 classifies the outcome; retries and waits are the runner's).
 * `secrets` are redacted from every error string. `fetchImpl` defaults to global `fetch`.
 */
export async function callWorkersAI(opts: {
  accountId: string;
  token: string;
  model: string;
  body: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<RestOutcome> {
  const secrets = [opts.token, opts.accountId];
  const safe = (s: string) => redact(s, secrets);
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as never);
  const timer = AbortSignal.timeout(opts.timeoutMs ?? MODEL_TIMEOUT_MS);
  let res: { status: number; text(): Promise<string>; headers?: { get(name: string): string | null } };
  try {
    res = await doFetch(endpointOf(opts.accountId, opts.model), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(opts.body),
      signal: timer,
    });
  } catch (error) {
    if (timer.aborted) return { kind: "timeout" };
    return { kind: "network", detail: safe(String(error)) };
  }
  const text = await res.text();
  if (res.status === 429 || errorCodes(text).some((c) => RATE_LIMIT_CODES.has(c))) {
    const retryAfter = res.headers?.get("retry-after");
    const retryMs = retryAfter === null || retryAfter === undefined ? 1000 : Number(retryAfter) * 1000;
    return { kind: "rate_limited", retry_after_ms: Number.isFinite(retryMs) ? retryMs : 1000 };
  }
  if (res.status >= 500 || errorCodes(text).some((c) => UNAVAILABLE_CODES.has(c))) {
    return { kind: "unavailable", status: res.status, detail: safe(text.slice(0, 500)) };
  }
  if (res.status !== 200) {
    return { kind: "rejected", status: res.status, detail: safe(text.slice(0, 500)) };
  }
  try {
    return { kind: "answer", result: resultOf(text) };
  } catch {
    return { kind: "answer", result: null }; // unreadable JSON: TL3 decides model_bad_output
  }
}
