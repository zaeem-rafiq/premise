// SE9 + EV2a + EM6: the `limits` event, the registered pools it reaches, and the one broadcast per
// LIMITS_EVERY_MS that spend and bucket changes are throttled to. Every emission is an `emit`
// effect for the shell; the Floor assigns `n` and `t` on append.
// Source: 01-core SE9, EV2a, EM6, the `limits` variant of 12.1.

import { LIMITS_EVERY_MS } from "../../protocol/constants.ts";
import type { ModelPlan } from "../../protocol/ports.ts";
import { usedLastMinute } from "./rate.ts";
import { reservedTotal, type GateState } from "./state.ts";
import type { GateEffect, GateRegisterPoolRequest, GateRegisterPoolResponse, LimitsEventBody } from "./types.ts";

/** The `limits` event body for `pool` at `now`: exactly the fields of the 12.1 `limits` variant.
 * `models` lists every model the plan rates plus every model that has a bucket, so a Clef bucket
 * the plan added later still shows. */
export function limitsBody(state: GateState, pool: string, now: number, plan: ModelPlan): LimitsEventBody {
  const models = new Set([...Object.keys(plan.per_minute), ...Object.keys(state.buckets)]);
  return {
    ts: now,
    pool,
    src: "gate",
    type: "limits",
    spend_usd: state.spent_usd,
    reserved_usd: reservedTotal(state),
    cap_usd: state.cap_usd,
    killed: state.killed,
    refusing: state.refusing,
    models: [...models].sort().map((model) => ({
      model,
      per_minute: plan.per_minute[model] ?? 0,
      used_last_minute: usedLastMinute(state, model, now),
    })),
  };
}

/** One `limits` event to one registered pool, under the pool's own `source_n` (EV2a). */
function emitTo(state: GateState, pool: string, now: number, plan: ModelPlan, effects: GateEffect[]): void {
  const entry = state.pools[pool];
  if (entry === undefined) return;
  entry.source_n += 1;
  effects.push({
    kind: "emit",
    pool,
    epoch: state.epoch,
    source_n: entry.source_n,
    event: limitsBody(state, pool, now, plan),
  });
}

/** A `limits` to every registered pool — the broadcast SE9 speaks of. */
export function broadcast(state: GateState, now: number, plan: ModelPlan, effects: GateEffect[]): void {
  for (const pool of Object.keys(state.pools)) emitTo(state, pool, now, plan, effects);
  state.limits_at = now;
  state.limits_dirty = false;
}

/**
 * SE9's spend/bucket path: "at most once per LIMITS_EVERY_MS while spend or a bucket changes".
 * Outside the window the change is broadcast at once; inside it, `limits_dirty` holds it for the
 * next due moment. A change while no pool is registered marks nothing — a pool learns the totals
 * at its registration.
 */
export function spendChanged(state: GateState, now: number, plan: ModelPlan, effects: GateEffect[]): void {
  if (Object.keys(state.pools).length === 0) return;
  if (state.limits_at === null || now - state.limits_at >= LIMITS_EVERY_MS) broadcast(state, now, plan, effects);
  else state.limits_dirty = true;
}

/**
 * The function SE9's throttle asks for: whether a held-back `limits` is due at `now`, and when the
 * next one is — the alarm the shell sets. A dirty flag without pools is not due (no receivers).
 */
export function limitsDue(state: GateState, now: number): { due: boolean; at: number | null } {
  if (!state.limits_dirty || Object.keys(state.pools).length === 0) return { due: false, at: null };
  const at = (state.limits_at ?? now) + LIMITS_EVERY_MS;
  return { due: now >= at, at };
}

/** Sends a due throttled `limits`; the sweep calls this so the shell needs one periodic entry. */
export function flushLimits(state: GateState, now: number, plan: ModelPlan, effects: GateEffect[]): void {
  if (limitsDue(state, now).due) broadcast(state, now, plan, effects);
}

/**
 * EV2a/EM6: registering a pool gives it a `source_n` sequence under the state's one `epoch` and
 * sends its first `limits` at once — "a pool's first `limits` event is sent at registration".
 * Idempotent at the level a route retry needs: a repeated call changes no flag and no membership,
 * and re-sends the current `limits` under the next `source_n`, so a lost first event is repaired
 * (the Floor ignores a duplicate `source_n`, keeps a fresh one).
 */
export function registerPool(
  state: GateState,
  req: GateRegisterPoolRequest,
  now: number,
  plan: ModelPlan,
): { answer: GateRegisterPoolResponse; effects: GateEffect[] } {
  const effects: GateEffect[] = [];
  if (state.pools[req.pool] === undefined) state.pools[req.pool] = { source_n: 0 };
  emitTo(state, req.pool, now, plan, effects);
  return { answer: { ok: true, pool: req.pool }, effects };
}
