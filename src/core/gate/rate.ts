// SE8: the rate limits of the gate — a token bucket per model, at the requests-per-minute of the
// model plan, and the `MAX_REAL_AGENTS` agent slots of MG5. Buckets and slots live in GateState.
// Source: 01-core SE8; 05-agent MG5.

import type { ModelPlan } from "../../protocol/ports.ts";
import { realAgents, SLOT_RETRY_MS, type Bucket, type GateState } from "./state.ts";
import type { GateMayStartRequest, GateMayStartResponse, GateReleaseRequest, GateReleaseResponse } from "./types.ts";

const MINUTE_MS = 60_000;

/** The bucket's `per_minute`, or null for a model the plan does not rate. SE8 fixes a bucket "per
 * model with the requests per minute of the model plan, and Clef's own bucket": the bucket key is
 * the model id, so Clef never shares a coding model's bucket; its own rate is the `per_minute`
 * entry of its Clef model id when the plan carries one (the starting plan has none, so its calls
 * are unthrottled — the spend cap still bounds them). */
export function bucketRate(model: string, plan: ModelPlan): number | null {
  const rate = plan.per_minute[model];
  return typeof rate === "number" && rate > 0 ? rate : null;
}

/** Continuous refill, the simplest reading of SE8's "requests per minute": a bucket holds at most
 * `rate` tokens and regains `rate / 60,000` per millisecond. */
function refill(bucket: Bucket, rate: number, now: number): void {
  if (now <= bucket.updated_at) return;
  bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.updated_at) * rate) / MINUTE_MS);
  bucket.used = bucket.used.filter((t) => t >= now - MINUTE_MS);
  bucket.updated_at = now;
}

/**
 * Take one token of `model`'s bucket. A call over the bucket is not refused: the answer is
 * `{ retry_after_ms }`, the time until one full token exists again (SE8). A model without a
 * `per_minute` is not rate-limited.
 */
export function take(
  state: GateState,
  model: string,
  now: number,
  plan: ModelPlan,
): { ok: true } | { ok: false; retry_after_ms: number } {
  const rate = bucketRate(model, plan);
  if (rate === null) return { ok: true };
  let bucket = state.buckets[model];
  if (bucket === undefined) {
    bucket = { tokens: rate, updated_at: now, used: [] };
    state.buckets[model] = bucket;
  }
  refill(bucket, rate, now);
  if (bucket.tokens < 1) {
    // The wait until `tokens` reaches 1 at `rate` per minute: (1 - tokens) * 60,000 / rate ms,
    // rounded up so the woken call finds the token already there.
    return { ok: false, retry_after_ms: Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / rate) };
  }
  bucket.tokens -= 1;
  bucket.used.push(now);
  return { ok: true };
}

/** The `used_last_minute` of the `limits` event: granted calls of this model in the last 60 s. */
export function usedLastMinute(state: GateState, model: string, now: number): number {
  const bucket = state.buckets[model];
  if (bucket === undefined) return 0;
  return bucket.used.filter((t) => t >= now - MINUTE_MS).length;
}

/** SE8/MG5: may a new real agent's loop start? An asker that already holds a slot always may.
 * The counts are the `real_agents` and `max_real_agents` that `pool.state` shows. */
export function mayStart(state: GateState, req: GateMayStartRequest, plan: ModelPlan): GateMayStartResponse {
  const held = req.attempt_id !== undefined && state.slots[req.attempt_id] !== undefined;
  const count = realAgents(state);
  if (held || count < plan.max_real_agents) {
    return { ok: true, real_agents: count, max_real_agents: plan.max_real_agents };
  }
  return { ok: false, retry_after_ms: SLOT_RETRY_MS, real_agents: count, max_real_agents: plan.max_real_agents };
}

/** MG5: an Agent releases its slot when its loop goes to waiting or ends. Idempotent. */
export function release(state: GateState, req: GateReleaseRequest): { answer: GateReleaseResponse } {
  const had = state.slots[req.attempt_id] !== undefined;
  delete state.slots[req.attempt_id];
  return { answer: { ok: true, released: had } };
}
