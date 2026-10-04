// The model gate's state (SE6 to SE12): plain data that serialises to JSON, so the Durable Object
// shell stores it and it survives a restart (SE12). No clock, no randomness, no async (plan 1.3):
// the present time, reservation ids and every number arrive as arguments or live in this state.
// Sources: 01-core 13.3 (SE6-SE9), 13.4 (SE10-SE12), 12.1-12.2 (`limits`, EV2a, EM6), S5;
// 05-agent 5.2 (MG4 to MG7).

import { MODEL_TIMEOUT_MS, RESERVATION_MARGIN_MS, WAIT_BACKOFF_BASE_MS } from "../../protocol/constants.ts";
import type { ModelPlan } from "../../protocol/ports.ts";

/** One open reservation (SE6): `amount_usd` is the bound of MG6 (`reservationBound`), `expires_at`
 * the moment by which it must be settled (SE6a). */
export type Reservation = {
  id: string;
  attempt_id: string;
  pool: string;
  model: string;
  amount_usd: number;
  expires_at: number;
};

/** The token bucket of one model id (SE8): capacity is the model's `per_minute`, refilled
 * continuously. `used` holds the granted-call times of the last minute and backs the `limits`
 * event's `used_last_minute`. */
export type Bucket = {
  tokens: number;
  updated_at: number;
  used: number[];
};

/** A registered pool (EV2a): the gate's own `source_n` sequence for that pool's stream, under the
 * one `epoch` of the state. `source_n` is the last number sent; the next event takes +1. */
export type PoolEntry = { source_n: number };

export type GateState = {
  cap_usd: number; // SPEND_CAP_USD of the deployment, fixed when the shell first stores the state
  spent_usd: number; // settled spend; never reset (BP9)
  killed: boolean; // SE10-SE12: survives restarts because it is part of this state
  refusing: boolean; // SE7: true while the last reserve was refused for the cap
  epoch: number; // EV2a: one epoch of `source_n` per pool
  next_reservation: number; // the counter reservation ids are derived from — never random
  reservations: Record<string, Reservation>;
  slots: Record<string, { pool: string }>; // MG5: attempt_id -> held real-agent slot
  pools: Record<string, PoolEntry>;
  buckets: Record<string, Bucket>; // one per model id that the plan rates (SE8)
  limits_at: number | null; // the last `limits` broadcast to every pool
  limits_dirty: boolean; // spend or a bucket changed while the SE9 throttle held the event back
};

/** The gate's starting state. `capUsd` is the deployment's `SPEND_CAP_USD` variable. */
export function initialState(capUsd: number): GateState {
  return {
    cap_usd: capUsd,
    spent_usd: 0,
    killed: false,
    refusing: false,
    epoch: 1,
    next_reservation: 0,
    reservations: {},
    slots: {},
    pools: {},
    buckets: {},
    limits_at: null,
    limits_dirty: false,
  };
}

/** SE6a: a reservation lives `MODEL_TIMEOUT_MS` plus `RESERVATION_MARGIN_MS`. */
export const RESERVATION_TTL_MS = MODEL_TIMEOUT_MS + RESERVATION_MARGIN_MS;

/** The wait the gate answers when no agent slot is free (SE8's `{ retry_after_ms }`, MG5). The
 * spec names no number; the agent's own wait backoff base is the closest paced wait it knows. */
export const SLOT_RETRY_MS = WAIT_BACKOFF_BASE_MS;

/** The sum of every open reservation's bound — the `reserved_usd` of SE7 and of `limits`. */
export function reservedTotal(state: GateState): number {
  let total = 0;
  for (const r of Object.values(state.reservations)) total += r.amount_usd;
  return total;
}

/** The number of real agents whose loop is running (MG5): the `real_agents` `pool.state` shows. */
export function realAgents(state: GateState): number {
  return Object.keys(state.slots).length;
}

/** MG5 meets MG7: a model of the plan (the workhorse or a race model) is a coding model an Agent
 * calls for its own loop, so its first granted reservation holds a real-agent slot. Any other
 * model id is Clef's, which is Trunk's call — it never takes a slot. */
export function isAgentModel(model: string, plan: ModelPlan): boolean {
  return model === plan.workhorse || plan.race.includes(model);
}
