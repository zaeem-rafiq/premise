// SE10, SE11, SE12: the kill switch. `killed` lives in GateState, so it survives a restart and is
// cleared only by the owner. The `landings: false` variant returns the "pause the pool with
// reason owner" effect for every registered pool; the pause itself is Trunk's (SE11).
// Source: 01-core 13.4; KillRequest of 13.6.

import type { KillRequest } from "../../protocol/routes.ts";
import type { ModelPlan } from "../../protocol/ports.ts";
import { broadcast } from "./limits.ts";
import type { GateState } from "./state.ts";
import type { GateEffect, GateKillResponse } from "./types.ts";

/**
 * `POST /api/kill`. On a change of `killed` every registered pool gets a `limits` at once (SE9:
 * "whenever killed or refusing changes"). `{"killed": true, "landings": false}` also asks each
 * pool's Trunk to pause with reason `owner` (SE11); `{"killed": false}` asks each pool's Trunk to
 * resume, but only a pool paused with reason `owner` answers it (SE12). Both effects are
 * idempotent, so they go out on every matching request — a lost one is repaired by a retry.
 * `landings` matters only next to `killed: true`: SE11 names no `{"killed": false, "landings": ...}`
 * form, so it is ignored there.
 */
export function setKilled(
  state: GateState,
  req: KillRequest,
  now: number,
  plan: ModelPlan,
): { answer: GateKillResponse; effects: GateEffect[] } {
  const effects: GateEffect[] = [];
  if (state.killed !== req.killed) {
    state.killed = req.killed;
    broadcast(state, now, plan, effects);
  }
  for (const pool of Object.keys(state.pools)) {
    if (req.killed && req.landings === false) effects.push({ kind: "pause_pool", pool, reason: "owner" });
    if (!req.killed) effects.push({ kind: "resume_pool", pool, reason: "owner" });
  }
  return { answer: { ok: true, killed: state.killed }, effects };
}
