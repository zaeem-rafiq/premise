// SE6, SE6a, SE7: reservations, settlement and the spend cap. `reserve` answers the caller of
// 05-agent 5.2; `settle` charges the real cost or the full bound; `sweep` charges what was never
// settled in time. Money arithmetic is reused from `src/core/agent/loop/model.ts` (costUsd,
// reservationBound), never copied.
// Source: 01-core SE6, SE6a, SE7, SE10's refusal; 05-agent MG4 to MG6.

import type { ModelPlan } from "../../protocol/ports.ts";
import { costUsd, reservationBound, type ModelPrice } from "../agent/loop/model.ts";
import { take } from "./rate.ts";
import { broadcast, flushLimits, spendChanged } from "./limits.ts";
import { isAgentModel, realAgents, reservedTotal, RESERVATION_TTL_MS, SLOT_RETRY_MS, type GateState } from "./state.ts";
import type {
  GateEffect,
  GateReserveRequest,
  GateReserveResponse,
  GateSettleRequest,
  GateSettleResponse,
  GateSweepResponse,
  PriceTable,
} from "./types.ts";

function priceOf(model: string, prices: PriceTable): ModelPrice | null {
  const p = prices[model];
  return p === undefined ? null : { input: p.in, output: p.out };
}

/**
 * The amount SE6 reserves: `request_bytes` at input price plus `max_tokens` at output price
 * (MG6). A model the price table does not name, or a request whose sizes are not usable numbers,
 * has no bound — SE6a fails closed: "spend can be over-counted, never under-counted", so the
 * bound is infinite and the cap check below refuses it as `spend_cap`.
 */
export function amountOf(req: GateReserveRequest, prices: PriceTable): number {
  const price = priceOf(req.model, prices);
  if (
    price === null ||
    !Number.isFinite(req.request_bytes) ||
    !Number.isFinite(req.max_tokens) ||
    req.request_bytes < 0 ||
    req.max_tokens < 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return reservationBound(req.request_bytes, req.max_tokens, price);
}

/** SE7's `refusing`, updated on the outcomes that name it: a refusal for the cap sets it, an
 * accepted reservation clears it; a `killed` refusal or a `retry_after_ms` leaves it. */
function setRefusing(state: GateState, refusing: boolean, now: number, plan: ModelPlan, effects: GateEffect[]): void {
  if (state.refusing === refusing) return;
  state.refusing = refusing;
  broadcast(state, now, plan, effects); // SE9: `refusing` changed -> limits to every pool at once
}

/**
 * SE6/SE7/SE8/SE10: refuse `killed` first (SE10 — every call), then the cap (SE7), then a missing
 * agent slot (MG5), then the model's bucket (SE8). Order among the two waits: the slot question is
 * answered before a bucket token is spent, so a call that cannot run yet never wastes rate.
 */
export function reserve(
  state: GateState,
  req: GateReserveRequest,
  now: number,
  plan: ModelPlan,
  prices: PriceTable,
): { answer: GateReserveResponse; effects: GateEffect[] } {
  const effects: GateEffect[] = [];

  if (state.killed) return { answer: { ok: false, refused: "killed" }, effects };

  const amount = amountOf(req, prices);
  if (!(state.spent_usd + reservedTotal(state) + amount <= state.cap_usd)) {
    setRefusing(state, true, now, plan, effects);
    return { answer: { ok: false, refused: "spend_cap" }, effects };
  }

  const needsSlot = isAgentModel(req.model, plan) && state.slots[req.attempt_id] === undefined;
  if (needsSlot && realAgents(state) >= plan.max_real_agents) {
    return { answer: { ok: false, retry_after_ms: SLOT_RETRY_MS }, effects };
  }

  const bucket = take(state, req.model, now, plan);
  if (!bucket.ok) return { answer: { ok: false, retry_after_ms: bucket.retry_after_ms }, effects };

  if (needsSlot) state.slots[req.attempt_id] = { pool: req.pool };
  const id = `r${state.next_reservation + 1}`;
  state.next_reservation += 1;
  const expires_at = now + RESERVATION_TTL_MS;
  state.reservations[id] = {
    id,
    attempt_id: req.attempt_id,
    pool: req.pool,
    model: req.model,
    amount_usd: amount,
    expires_at,
  };

  // The one `limits` this call may emit covers both flips: `refusing` cleared is immediate (SE9),
  // with the flag already at its new value in the event; a spend or bucket change is throttled.
  if (state.refusing) {
    state.refusing = false;
    broadcast(state, now, plan, effects);
  } else {
    spendChanged(state, now, plan, effects);
  }

  return { answer: { ok: true, reservation_id: id, expires_at }, effects };
}

/**
 * SE6a: settle with the usage the provider reported — the real cost (`costUsd`) is charged and
 * the rest of the bound released. `usage: null` (a time-out, an eviction, an error after the
 * request was sent) or a settle that arrives at or past `expires_at` charges the full bound:
 * "not settled by expires_at" and "settled without a usage report" are the same charge.
 * A repeated settle, or one naming a reservation the state does not hold, changes nothing.
 */
export function settle(
  state: GateState,
  req: GateSettleRequest,
  now: number,
  plan: ModelPlan,
  prices: PriceTable,
): { answer: GateSettleResponse; effects: GateEffect[] } {
  const effects: GateEffect[] = [];
  const r = state.reservations[req.reservation_id];
  if (r === undefined) return { answer: { ok: true, charged_usd: 0, found: false }, effects };

  let charged: number;
  const price = priceOf(r.model, prices);
  const usage = req.usage;
  if (now >= r.expires_at || usage === null || price === null) {
    charged = r.amount_usd;
  } else if (
    !Number.isFinite(usage.tokens_in) ||
    !Number.isFinite(usage.tokens_out) ||
    usage.tokens_in < 0 ||
    usage.tokens_out < 0
  ) {
    charged = r.amount_usd; // unusable usage is no usage report (SE6a)
  } else {
    charged = costUsd(usage.tokens_in, usage.tokens_out, price);
  }

  state.spent_usd += charged;
  delete state.reservations[req.reservation_id];
  spendChanged(state, now, plan, effects);
  return { answer: { ok: true, charged_usd: charged, found: true }, effects };
}

/**
 * The expiry sweep of SE6a, run by the shell's alarm: every reservation whose `expires_at` has
 * passed is charged in full ("settled at its full reserved amount"), then a throttled `limits`
 * that is due goes out (SE9). The answer reports how many expired.
 */
export function sweep(
  state: GateState,
  now: number,
  plan: ModelPlan,
): { answer: GateSweepResponse; effects: GateEffect[] } {
  const effects: GateEffect[] = [];
  let expired = 0;
  for (const [id, r] of Object.entries(state.reservations)) {
    if (r.expires_at <= now) {
      state.spent_usd += r.amount_usd;
      delete state.reservations[id];
      expired += 1;
    }
  }
  if (expired > 0) spendChanged(state, now, plan, effects);
  else flushLimits(state, now, plan, effects);
  return { answer: { ok: true, expired }, effects };
}
