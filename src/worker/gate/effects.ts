// The `pause_pool` and `resume_pool` effects of the pure gate (SE11, SE12): `{"killed":true,
// "landings":false}` asks every registered pool's Trunk to pause with reason `owner`, and
// `{"killed":false}` asks it to resume — but only a pool paused with reason `owner` may answer.
//
// Trunk has no entry for this today: its engine table has no `pause`/`resume` entry, its `owner`
// action knows land/land_now/decline/choose/undo/retry/stop but no pause, and its HTTP shell maps
// no path to one. Until the trunk lane adds it, these two functions deliberately deliver nothing.
// What Trunk needs (named in the lane report): an engine entry that sets `pool_state = paused` and
// `pause_reason = owner` and emits `pool.paused { reason: "owner" }`, and a resume that answers
// only a `pause_reason` of `owner`; plus a path in its shell's `#entryFor` for each. Then the two
// calls below post to that path on `env.TRUNK.idFromName(pool)`.

import type { Env } from "../env.ts";

/** SE11's `pause_pool` effect: no Trunk entry exists for an owner pause — see this file's head. */
export async function pausePoolForOwner(_env: Env, _pool: string): Promise<void> {
  // Delivered nowhere on purpose: Trunk answers `not_built` to every pool-state entry today.
}

/** SE12's `resume_pool` effect: resumes only a pool paused with reason `owner` — same gap. */
export async function resumePoolForOwner(_env: Env, _pool: string): Promise<void> {
  // Delivered nowhere on purpose: see `pausePoolForOwner`.
}
