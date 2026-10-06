// The `swarm` source's delivery to one pool's stream (EV2a): `swarm.state` reaches the Floor of
// every registered pool ordered by that pool's own `(epoch, source_n)` counter.
//
// The launcher keeps no per-pool counter of its own — a Cloudflare Workflow has no storage the
// entrypoint may write. The Floor is the counter: `GET /internal/swarm-source` answers the swarm
// source's `(epoch, last_n)` at that pool and the newest `swarm.state` it appended, and the emit
// sends `last_n + 1`. A state the stream already carries (a retried emit whose reply was lost)
// or an emit older than the newest one (a slower retry) is confirmed without a new append, so a
// retried emit can never reorder a newer one behind it. A `gap` (another emit took the slot)
// reads the counter again.
//
// The outbox row is the emit's pending workflow step (EV2a): it is retried with backoff until
// the Floor confirms. `deliverToPool` throws on a transport failure or a refusal so the caller's
// step retries; it returns only on confirmation or when the stream already carries the state.

import type { Env } from "../env.ts";
import type { FloorAppendRequest, FloorAppendResponse, FloorSwarmSource } from "../../protocol/internal.ts";

/** The source id the Floor keeps for the Swarm launcher (EV2a's table). */
export const SWARM_SOURCE = "swarm";
/** The swarm source's epoch: the counter never restarts while a stream lives. */
export const SWARM_EPOCH = 1;
/** Bounded inner retries between caller-level (workflow step) retries. */
const MAX_ROUNDS = 6;

export type SwarmStateBody = {
  type: "swarm.state";
  synthetic: true;
  running: boolean;
  agents: number;
  collision_dial: number;
  pools: string[];
};

/** The swarm.state fields two emits compare — `ts` and the stream envelope stay out. */
function sameState(a: Record<string, unknown>, b: SwarmStateBody): boolean {
  return (
    a.type === "swarm.state" &&
    a.running === b.running &&
    a.agents === b.agents &&
    a.collision_dial === b.collision_dial &&
    JSON.stringify(a.pools ?? []) === JSON.stringify(b.pools)
  );
}

/** The swarm source's counter at `pool`'s Floor and the newest `swarm.state` it appended. */
export async function swarmSource(env: Env, pool: string): Promise<FloorSwarmSource> {
  const response = await env.FLOOR.get(env.FLOOR.idFromName(pool)).fetch("https://floor/internal/swarm-source");
  if (!response.ok) throw new Error(`swarm source of ${pool}: ${response.status}`);
  return (await response.json()) as FloorSwarmSource;
}

/**
 * Delivers one `swarm.state` to `pool`'s stream and returns only when the Floor confirmed it —
 * appended, or already carried (a duplicate's content or a stale emit needs nothing more).
 * Throws for the caller's retry while the row is unconfirmed.
 */
export async function deliverToPool(env: Env, pool: string, body: SwarmStateBody & { ts: number }): Promise<void> {
  const event: FloorAppendRequest["events"][number]["event"] = {
    ...body,
    pool,
    src: SWARM_SOURCE,
  };
  const post = (request: FloorAppendRequest) =>
    env.FLOOR.get(env.FLOOR.idFromName(pool)).fetch("https://floor/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const source = await swarmSource(env, pool);
    // Confirmed already: the stream carries this state, or a newer one than this emit.
    const newest = source.newest;
    if (newest !== null && (newest.ts >= body.ts || sameState(newest.event, body))) return;

    const sent = await post({
      source: SWARM_SOURCE,
      epoch: source.epoch ?? SWARM_EPOCH,
      events: [{ source_n: source.last_n + 1, event }],
    });
    const result = (await sent.json()) as FloorAppendResponse;
    if ("error" in result) {
      if (result.error.code === "gap") continue; // another emit took the slot: read the counter again
      // `bad_source`/`bad_append` means the emit itself is malformed — retrying cannot help it.
      throw new Error(`swarm emit to ${pool}: ${result.error.code}`);
    }
    if (result.duplicate === true) continue; // the slot was already used: read the counter again
    return; // appended — the Floor confirmed the row
  }
  throw new Error(`swarm emit to ${pool}: unconfirmed after ${MAX_ROUNDS} rounds`);
}
