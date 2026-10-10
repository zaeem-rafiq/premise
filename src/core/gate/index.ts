// The contract for the Durable Object shell (`src/worker/gate/gate-do.ts`, one per deployment):
// `apply` dispatches every call of the gate's protocol — reserve, settle, release, register-pool,
// kill, may-start, sweep — to the pure functions of this directory. `apply` never mutates the
// `state` it is given: it works on a deep clone and returns the new state, the answer and the
// effects. The shell stores the state (SQLite or `ctx.storage`), passes `Date.now()` as `now`,
// runs the effects after the call commits, and sets the alarm `nextWakeup` returns.
// Source: 05-agent 5.2; 01-core 13.3, 13.4, EV2a, EM6.

import type { ModelPlan } from "../../protocol/ports.ts";
import { limitsDue, registerPool } from "./limits.ts";
import { setKilled } from "./kill.ts";
import { claim, mayStart, release } from "./rate.ts";
import { reserve, settle, sweep } from "./reserve.ts";
import { initialState, type GateState } from "./state.ts";
import type { GateAnswer, GateCall, GateEffect, GateResult, PriceTable } from "./types.ts";

export { initialState } from "./state.ts";
export type { GateState, Reservation, Bucket, PoolEntry } from "./state.ts";
export { reservedTotal, realAgents, isAgentModel, RESERVATION_TTL_MS, SLOT_RETRY_MS } from "./state.ts";
export { take, usedLastMinute, mayStart, release, claim, bucketRate } from "./rate.ts";
export { reserve, settle, sweep, amountOf } from "./reserve.ts";
export { setKilled } from "./kill.ts";
export { registerPool, broadcast, spendChanged, limitsDue, flushLimits, limitsBody } from "./limits.ts";
export type {
  GateCall,
  GateAnswer,
  GateResult,
  GateEffect,
  LimitsEventBody,
  PriceTable,
  GateReserveRequest,
  GateReserveResponse,
  GateSettleRequest,
  GateSettleResponse,
  GateReleaseRequest,
  GateClaimRequest,
  GateClaimResponse,
  GateReleaseResponse,
  GateRegisterPoolRequest,
  GateRegisterPoolResponse,
  GateMayStartRequest,
  GateMayStartResponse,
  GateSweepRequest,
  GateSweepResponse,
  GateKillResponse,
} from "./types.ts";

/** The next moment the shell's alarm is needed for: the earliest reservation expiry (SE6a) or a
 * held-back `limits` falling due (SE9), whichever is first; null when nothing is pending. */
export function nextWakeup(state: GateState, now: number): number | null {
  let at: number | null = null;
  for (const r of Object.values(state.reservations)) {
    if (at === null || r.expires_at < at) at = r.expires_at;
  }
  const limits = limitsDue(state, now).at;
  if (limits !== null && (at === null || limits < at)) at = limits;
  return at;
}

/**
 * Dispatch one call. The input `state` is left untouched (a deep clone is worked on and returned),
 * so a shell may keep the stored value until the returned one is durable.
 */
export function apply(state: GateState, call: GateCall, now: number, plan: ModelPlan, prices: PriceTable): GateResult {
  const next = structuredClone(state);
  switch (call.call) {
    case "reserve": {
      const { answer, effects } = reserve(next, call.request, now, plan, prices);
      return { state: next, answer, effects };
    }
    case "settle": {
      const { answer, effects } = settle(next, call.request, now, plan, prices);
      return { state: next, answer, effects };
    }
    case "release": {
      const { answer } = release(next, call.request);
      return { state: next, answer, effects: [] };
    }
    case "claim": {
      const { answer } = claim(next, call.request, plan);
      return { state: next, answer, effects: [] };
    }
    case "register-pool": {
      const { answer, effects } = registerPool(next, call.request, now, plan);
      return { state: next, answer, effects };
    }
    case "kill": {
      const { answer, effects } = setKilled(next, call.request, now, plan);
      return { state: next, answer, effects };
    }
    case "may-start": {
      const answer = mayStart(next, call.request, plan);
      return { state: next, answer, effects: [] };
    }
    case "sweep": {
      const { answer, effects } = sweep(next, now, plan);
      return { state: next, answer, effects };
    }
  }
}
