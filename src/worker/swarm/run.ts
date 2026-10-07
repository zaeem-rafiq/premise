// The launch loop of a Swarm run (01-core SWR1, 02-tidepool 10.4): `run-<pool>` emits `running`
// state, launches `config.agents` scripted agents at `launch_per_second` — agent n's pattern
// drawn from `collision_dial` with `agentRandom(seed, n)` (SW1), one `rescale-energy` every
// `rescale_every_s` while the dial is positive — takes `SWARM_CONTROL_EVENT` events (dial,
// agents, stop) and emits every change. It ends on `stop`, on the kill switch, or by itself once
// its last agent is launched (`runTick`): `running` means launching.
//
// One tick launches every agent that is due CONCURRENTLY — bounded at `launch_per_second` at a
// time — inside a single `tick-<n>` step that also holds the kill switch and the tick's clock. A
// run's step count then grows with its ticks and not with its agents (a Workflow instance replays
// its completed steps whenever it resumes, so one `launch-<seq>` step per agent resumed ever more
// slowly — the live soak of 2026-10-05 fell from 38 launches a minute to 6). A replayed tick does
// not launch an agent twice: a completed step never re-runs, and a retried or re-run tick
// relaunches the same attempt ids, which Trunk's `open-attempt` and the Agent's `/open`
// deduplicate (9.8).
//
// Extracted from the Workflow entrypoint so the unit tests drive the loop with a fake step and a
// fake `env`: `cloudflare:workers` is a type-only import here, nothing of it resolves at runtime.

import type { WorkflowStep, WorkflowStepEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { SwarmControlEvent, SwarmRunParams } from "../../protocol/internal.ts";
import { SWARM_CONTROL_EVENT } from "../../protocol/internal.ts";
import { PUSH_BACKOFF_BASE_MS } from "../../protocol/constants.ts";
import { emitSwarmState } from "./emit.ts";
import { launchAgent, launchId, type LaunchInput } from "./launch.ts";
import { patternById, type Pattern } from "../../swarm/pattern.ts";
import { dialPick } from "../../swarm/dial.ts";
import { agentRandom } from "../../swarm/prng.ts";
import { runTick } from "../../swarm/run-schedule.ts";
import { isWaitTimeout } from "./wait-timeout.ts";

/** The emit's outbox row retried with backoff — a step completes only once the Floor confirmed. */
const EMIT_RETRY = {
  retries: { limit: 12, delay: PUSH_BACKOFF_BASE_MS, backoff: "exponential" as const },
};
/**
 * Unexpected launch failures retry the step. A busy Trunk completes the step with pending
 * launches instead, so its retry budget cannot end the run while Trunk is unavailable.
 */
const TICK_RETRY = {
  retries: { limit: 6, delay: PUSH_BACKOFF_BASE_MS, backoff: "exponential" as const },
};

/** The gate's kill switch (SE10): unknown or unreachable means not killed. */
async function killed(env: Env): Promise<boolean> {
  try {
    const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/killed");
    if (!response.ok) return false;
    return ((await response.json()) as { killed?: unknown }).killed === true;
  } catch {
    return false;
  }
}

/** A reserved SW1 draw, including its truth, survives dial changes and Workflow replay. */
type PendingLaunch = { kind: "regular" | "rescale"; input: LaunchInput };

/** What a `tick-<n>` step leaves the loop: completed counts and launches still owed. */
type TickOutcome = {
  /** The kill switch: stop launching, end the run. */
  stop: boolean;
  /** Regular agents due and launched so far (`runTick`'s `regularDue`). */
  regular: number;
  /** Rescale agents due and launched so far (`runTick`'s `rescaleDue`). */
  rescale: number;
  /** Reserved launches that must finish before any new draws are assigned. */
  pending: PendingLaunch[];
  /** All launches due by the end of the run have completed. */
  ended: boolean;
};

export type SwarmRunDeps = {
  /** The clock a tick reads — a step result in the Workflow (`Date.now`), a fake in tests. */
  now?: () => number;
};

/** `run-<pool>`: the launch loop and its `swarm.state` emissions (SWR1, SWR4). */
export async function runSwarmLaunch(
  env: Env,
  params: SwarmRunParams,
  step: WorkflowStep,
  deps: SwarmRunDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const { pool, request_id } = params;
  let { agents, collision_dial } = params.config;
  const { seed, launch_per_second, think_ms, rescale_every_s } = params.config;
  const hold = new Set(params.config.hold_before_submit ?? []);

  let emits = 0;
  /** One emission: a stable `ts` step result, then the fan-out as the retried row. */
  const emit = async (patch: { running?: boolean; agents?: number; collision_dial?: number }) => {
    const ts = await step.do<number>(`emit-ts-${emits}`, async () => now());
    await step.do(`emit-${emits}`, EMIT_RETRY, () => emitSwarmState(env, patch, ts));
    emits += 1;
  };

  /** Freeze one launch; `seq` is its draw-stream index (SW1) and its name's `n`. */
  const reserve = (seq: number, pattern: Pattern): LaunchInput => {
    const rand = agentRandom(seed, seq);
    const truth = pattern.truthOf === undefined ? pattern.truth : pattern.truthOf(rand);
    return {
      pool,
      attemptId: launchId("a_", request_id, seq),
      intentId: launchId("i_", request_id, seq),
      pattern: { id: pattern.id, intent: pattern.intent, truth },
      seed,
      agentN: seq,
      hold: hold.has(pattern.id),
      thinkMs: think_ms,
    };
  };

  const startMs = await step.do<number>("start", async () => now());
  await emit({ running: true, agents, collision_dial });

  // Pace one-second ticks: each waits on a control event; the timeout is the tick. `regular` and
  // `rescale` are the cumulative dues met — `regular` counts only the run's `agents`, so a
  // rescale-energy launch never fills the configured quota. Each tick costs two steps — the wait
  // and the one `tick-<n>` that holds the kill switch, the clock and that tick's whole launch
  // fan-out — well inside a Workflow instance's step limit for a run that ends by itself.
  let regular = 0;
  let rescale = 0;
  let pending: PendingLaunch[] = [];
  let tick = 0;
  while (true) {
    let control: SwarmControlEvent["payload"] | null = null;
    try {
      const event: WorkflowStepEvent<SwarmControlEvent["payload"]> = await step.waitForEvent(`control-${tick}`, {
        type: SWARM_CONTROL_EVENT,
        timeout: "1 second",
      });
      control = event.payload ?? null;
    } catch (cause) {
      if (!isWaitTimeout(cause)) throw cause;
    }
    tick += 1;

    if (control?.op === "dial") {
      collision_dial = control.collision_dial;
      await emit({ collision_dial });
    } else if (control?.op === "agents") {
      const reservedRegular = pending.filter((item) => item.kind === "regular").length;
      agents = Math.max(regular + reservedRegular, control.agents);
      await emit({ agents });
    } else if (control?.op === "stop") {
      break;
    }

    // One step for the tick: the kill switch, the tick's clock (a step result, so a replay after
    // a restart sees the same schedule), the dues of `runTick`, then every due launch at once —
    // bounded at `launch_per_second` in flight.
    const regularBefore = regular;
    const rescaleBefore = rescale;
    const pendingBefore = pending;
    const outcome = await step.do<TickOutcome>(`tick-${tick}`, TICK_RETRY, async () => {
      if (await killed(env)) {
        return { stop: true, regular: regularBefore, rescale: rescaleBefore, pending: pendingBefore, ended: false };
      }
      const due = runTick({
        now: now(),
        startMs,
        agents,
        launchPerSecond: launch_per_second,
        collisionDial: collision_dial,
        rescaleEverySecs: rescale_every_s,
      });
      // Pending draws were reserved under an earlier dial and schedule. Finish them before
      // assigning new indices, so a slow Trunk cannot turn a rescale into a regular agent.
      const batch: PendingLaunch[] = [...pendingBefore];
      if (batch.length === 0) {
        let seq = regularBefore + rescaleBefore;
        for (let dueN = regularBefore; dueN < due.regularDue; dueN += 1, seq += 1) {
          batch.push({ kind: "regular", input: reserve(seq, dialPick(collision_dial, agentRandom(seed, seq))) });
        }
        for (let dueN = rescaleBefore; dueN < due.rescaleDue; dueN += 1, seq += 1) {
          const pattern = patternById("rescale-energy");
          if (pattern === undefined) throw new Error("swarm run: unknown pattern rescale-energy");
          batch.push({ kind: "rescale", input: reserve(seq, pattern) });
        }
      }
      let regularDone = regularBefore;
      let rescaleDone = rescaleBefore;
      const remaining: PendingLaunch[] = [];
      const bound = Math.max(1, Math.floor(launch_per_second));
      for (let at = 0; at < batch.length; at += bound) {
        const chunk = batch.slice(at, at + bound);
        const results = await Promise.all(chunk.map((item) => launchAgent(env, item.input)));
        for (const [i, result] of results.entries()) {
          const item = chunk[i]!;
          if (result.ok) {
            if (item.kind === "regular") regularDone += 1;
            else rescaleDone += 1;
          } else if (result.code === "trunk_open_failed" || result.code === "trunk_hold_failed") {
            remaining.push(item);
          } else {
            throw new Error(`tick ${tick} launch ${item.input.agentN}: ${result.code}`);
          }
        }
        if (remaining.length > 0) {
          remaining.push(...batch.slice(at + bound));
          break;
        }
      }
      return {
        stop: false,
        regular: regularDone,
        rescale: rescaleDone,
        pending: remaining,
        ended: remaining.length === 0 && regularDone >= agents && rescaleDone >= due.rescaleDue,
      };
    });
    if (outcome.stop) break;
    regular = outcome.regular;
    rescale = outcome.rescale;
    pending = outcome.pending;
    // The last agent is launched: the run is over (its agents finish on their own).
    if (outcome.ended) break;
  }

  await emit({ running: false });
}
