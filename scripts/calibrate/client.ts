// The model client of `calibrate:clef`. The default is Workers AI over its REST API, the same
// path `measure:models` uses (`scripts/measure/early/workers-ai-rest.ts`): credentials come from
// `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment, travel only in the
// request's Authorization header, and every error text passes through `redact()` (BP7). A test
// passes a fake `AiBinding`, or a fake `fetch` under the REST binding.

import { MODEL_PLAN } from "../../src/config/model-plan.ts";
import type { GateReserveResponse, GateSettleResponse } from "../../src/protocol/internal.ts";
import { redact } from "../../src/protocol/redact.ts";
import type { AiBinding } from "../../src/worker/adapters/model/workers-ai.ts";
import type { ClefGate } from "../../src/worker/adapters/triage/clef-call.ts";
import { callWorkersAI, type FetchLike } from "../measure/early/workers-ai-rest.ts";

export type Credentials = { accountId: string; token: string };

/** The two variables `measure:models` reads; null when either is missing. Never logs a value. */
export function credentialsFromEnv(env: Record<string, string | undefined>): Credentials | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  return accountId === "" || token === "" ? null : { accountId, token };
}

/**
 * The `AiBinding` surface over REST. A failure is thrown as `{ status }`, which
 * `classifyModelError` of the model adapter reads (TL12); `onError` receives the redacted detail.
 */
export function restBinding(
  creds: Credentials,
  opts: { fetchImpl?: FetchLike; timeoutMs: number; onError?: (detail: string) => void },
): AiBinding {
  const secrets = [creds.token, creds.accountId];
  return {
    async run(model, request) {
      const outcome = await callWorkersAI({
        accountId: creds.accountId,
        token: creds.token,
        model,
        body: request,
        timeoutMs: opts.timeoutMs,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (outcome.kind === "answer") return outcome.result;
      const detail =
        outcome.kind === "unavailable" || outcome.kind === "rejected"
          ? `http ${outcome.status}: ${outcome.detail}`
          : outcome.kind === "network"
            ? `network: ${outcome.detail}`
            : outcome.kind;
      opts.onError?.(redact(`${model}: ${detail}`, secrets));
      const status =
        outcome.kind === "rate_limited"
          ? 429
          : outcome.kind === "rejected" || outcome.kind === "unavailable"
            ? outcome.status
            : outcome.kind === "timeout"
              ? 504
              : 503;
      throw { status };
    },
  };
}

/** USD per input token of a Clef model (01-core TR10: no charge for output tokens). */
export function inputPrice(modelId: string): number {
  const price = MODEL_PLAN.prices_usd_per_mtok[modelId];
  if (price === undefined) throw new Error(`no price for ${modelId} in the model plan`);
  return price.in / 1_000_000;
}

/**
 * A local stand-in for the model gate (TR9): it never refuses for rate, refuses `spend_cap` once
 * `maxUsd` is spent, and adds up the input tokens each call reports at the model plan's price.
 */
export class LedgerGate implements ClefGate {
  readonly maxUsd: number;
  spentUsd = 0;
  calls = 0;
  tokensIn = 0;
  readonly #open = new Map<string, string>();
  #next = 0;

  constructor(maxUsd: number) {
    this.maxUsd = maxUsd;
  }

  async reserve(request: { model: string }): Promise<GateReserveResponse> {
    if (this.spentUsd >= this.maxUsd) return { ok: false, refused: "spend_cap" };
    const id = `r${(this.#next += 1)}`;
    this.#open.set(id, request.model);
    return { ok: true, reservation_id: id, expires_at: 0 };
  }

  async settle(request: {
    reservation_id: string;
    usage: { tokens_in: number; tokens_out: number } | null;
  }): Promise<GateSettleResponse> {
    const model = this.#open.get(request.reservation_id);
    this.#open.delete(request.reservation_id);
    if (model === undefined) return { ok: true, charged_usd: 0, found: false };
    this.calls += 1;
    const tokens = request.usage?.tokens_in ?? 0;
    this.tokensIn += tokens;
    const charged = tokens * inputPrice(model);
    this.spentUsd += charged;
    return { ok: true, charged_usd: charged, found: true };
  }
}
