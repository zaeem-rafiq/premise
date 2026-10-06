// The `swarm` source's delivery to one pool's stream (EV2a): `swarm.state` reaches the Floor of
// every registered pool ordered by that pool's own `(epoch, source_n)` counter.
//
// The launcher keeps no per-pool counter of its own — a Cloudflare Workflow has no storage the
// entrypoint may write, and the build plan gives the lane no Durable Object. Instead each emit
// discovers the pool's counter from the Floor itself, through the resend handshake EV2 defines:
// a probe append whose `source_n` is far above the real counter is refused with `gap` carrying
// the `source_n` the Floor expects (`last_n + 1`), which is exactly the number the emit then
// sends. The Floor's `sources` table is the per-pool counter EV2a asks for; a duplicated or
// lost reply is recovered by re-reading the stream (the event is content-addressed by `ts`
// and its fields — a re-sent `swarm.state` that matches the stream's newest one is a duplicate,
// and an emit older than the newest reported state is stale and dropped, so a slower retried
// emit can never reorder a newer one behind it).
//
// The outbox row is the emit's pending workflow step (EV2a): it is retried with backoff until
// the Floor confirms, and a `swarm.state` stays "in the outbox" for as long as no Floor answer
// confirms it. `deliverToPool` throws on a transport failure or a refusal so the caller's step
// retries; it returns only on confirmation or when the stream already carries the state.

import type { Env } from "../env.ts";
import type { FloorAppendRequest, FloorAppendResponse } from "../../protocol/internal.ts";

/** The source id the Floor keeps for the Swarm launcher (EV2a's table). */
export const SWARM_SOURCE = "swarm";
/** The swarm source's epoch: the counter never restarts while a stream lives. */
export const SWARM_EPOCH = 1;
/** The probe's `source_n` — always above the pool's real counter, so the probe never appends. */
const PROBE_N = Number.MAX_SAFE_INTEGER;
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

/**
 * The newest `swarm` event on `pool`'s stream, or null when the pool carries none yet (404 on
 * an empty stream answers "none"). Reads the Replay export the Floor serves (12.3).
 */
export async function lastSwarmEvent(
  env: Env,
  pool: string,
): Promise<{ ts: number; body: Record<string, unknown> } | null> {
  const response = await env.FLOOR.get(env.FLOOR.idFromName(pool)).fetch(
    `https://floor/api/pools/${pool}/replay.ndjson`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`replay of ${pool}: ${response.status}`);
  const lines = (await response.text()).trim().split("\n");
  let found: { ts: number; body: Record<string, unknown> } | null = null;
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.src === SWARM_SOURCE && event.type === "swarm.state") {
      found = { ts: event.ts as number, body: event };
    }
  }
  return found;
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

  let epoch = SWARM_EPOCH;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // Confirm short-circuit: the stream's newest swarm.state at-or-after this emit's `ts`
    // carries at least as new a state; an identical one already delivered is a duplicate.
    const newest = await lastSwarmEvent(env, pool);
    if (newest !== null && (newest.ts >= body.ts || sameState(newest.body, body))) return;

    // EV2a: ask the counter — a probe at a `source_n` the stream can never reach answers
    // `gap` with the `last_n + 1` the real row must carry. A `duplicate` answer to it says
    // the stored epoch is newer — this emit restarts its sequence one higher (RB5).
    const probe = await post({
      source: SWARM_SOURCE,
      epoch,
      events: [{ source_n: PROBE_N, event }],
    });
    const answer = (await probe.json()) as FloorAppendResponse;
    if (!("error" in answer)) {
      epoch += 1;
      continue;
    }
    if (answer.error.code !== "gap" || answer.error.expected === undefined) {
      // `bad_source`/`bad_append` means the emit itself is malformed — retrying cannot help it.
      throw new Error(`swarm emit to ${pool}: ${answer.error.code}`);
    }

    const sent = await post({
      source: SWARM_SOURCE,
      epoch,
      events: [{ source_n: answer.error.expected, event }],
    });
    const result = (await sent.json()) as FloorAppendResponse;
    if ("error" in result) {
      if (result.error.code === "gap") continue; // another emit took the slot: recount
      throw new Error(`swarm emit to ${pool}: ${result.error.code}`);
    }
    if (result.duplicate === true) continue; // same — the expected source_n was already used
    return; // appended — the Floor confirmed the row
  }
  throw new Error(`swarm emit to ${pool}: unconfirmed after ${MAX_ROUNDS} rounds`);
}
