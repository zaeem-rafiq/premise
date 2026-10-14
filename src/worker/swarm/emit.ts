// One `swarm.state` emission to every registered pool (EM6, EV2a).
//
// The registered pools are read from the model gate's own registry — pool creation registers a
// pool with the gate and the launcher in one call (PL1), so the gate's set and the launcher's
// are the same; a gate read that fails fails the emit so its step retries.
//
// The "current" swarm state lives only in the streams the launcher already wrote (the stream
// is the record — the launcher keeps no store of its own): `currentSwarm` reads back the newest
// `swarm.state` of any registered pool. `emitSwarmState` merges the caller's change over it,
// stamps the emit with `ts`, and delivers it to every pool through `deliverToPool` — the
// pool's own `swarm` counter numbers it (EV2a).

import type { Env } from "../env.ts";
import { DEFAULT_POOL, SWARM_POOL } from "../../config/pools.ts";
import { deliverToPool, swarmSource, type SwarmStateBody } from "./deliver.ts";

/** How many pools one emit delivers to at once. */
const EMIT_PARALLEL = 16;

export type SwarmPatch = { running?: boolean; agents?: number; collision_dial?: number };

/** The gate's `/internal/state` answer: `state.pools` is the registration set (EV2a/PL1). */
type GateStateAnswer = { state?: { pools?: Record<string, unknown> } | null };

/** Every pool registered at creation — the emit's destination set and its `pools` field. */
export async function registeredPools(env: Env): Promise<string[]> {
  const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/internal/state");
  if (!response.ok) throw new Error(`gate state: ${response.status}`);
  const body = (await response.json()) as GateStateAnswer;
  return Object.keys(body.state?.pools ?? {});
}

/** The newest swarm.state any pool's stream carries; the idle default when none exists yet. */
export async function currentSwarm(
  env: Env,
  pools: string[],
): Promise<{ running: boolean; agents: number; collision_dial: number }> {
  for (const pool of [SWARM_POOL, DEFAULT_POOL, ...pools]) {
    try {
      const newest = (await swarmSource(env, pool)).newest?.event;
      if (newest !== undefined) {
        return {
          running: newest.running === true,
          agents: typeof newest.agents === "number" ? newest.agents : 0,
          collision_dial: typeof newest.collision_dial === "number" ? newest.collision_dial : 0,
        };
      }
    } catch {
      // An unreachable pool is skipped — another stream still carries the state.
    }
  }
  return { running: false, agents: 0, collision_dial: 0 };
}

/**
 * Emits `swarm.state` to every registered pool: `patch` over the stream's newest state, `ts`
 * the emit's commit clock. Throws while any pool stays unconfirmed — the caller (a workflow
 * step) retries the whole fan-out; already-confirmed pools deduplicate in `deliverToPool`.
 */
export async function emitSwarmState(env: Env, patch: SwarmPatch, ts: number): Promise<void> {
  const pools = await registeredPools(env);
  if (pools.length === 0) return; // no pool has ever registered: there is no stream to write
  const current = await currentSwarm(env, pools);
  const body: SwarmStateBody & { ts: number } = {
    ts,
    type: "swarm.state",
    synthetic: true,
    running: patch.running ?? current.running,
    agents: patch.agents ?? current.agents,
    collision_dial: patch.collision_dial ?? current.collision_dial,
    pools,
  };
  // EMIT_PARALLEL pools at a time: one after another, a stop took 52 s with the Try pools of
  // `test` registered (2026-10-14). Every pool is still tried; any failure fails the step.
  const failures: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < pools.length) {
      const pool = pools[next++]!;
      try {
        await deliverToPool(env, pool, body);
      } catch (cause) {
        failures.push(cause);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMIT_PARALLEL, pools.length) }, worker));
  if (failures.length > 0) throw failures[0];
}
