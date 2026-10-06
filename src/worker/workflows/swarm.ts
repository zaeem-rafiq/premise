// The Swarm launcher (01-core SWR1, EM6, EV2a): the `SWARM` Workflow of the brief. Three
// instance kinds run here:
//
//   register_pool — pool creation's registration (PL1): emits the current `swarm.state` to
//     every registered pool, so the new stream receives it on its own `swarm` counter.
//   emit          — one `swarm.state` emission a route asked for (a dial change or a stop
//     with no live run): durable at-least-once delivery as a retried step.
//   run           — a Swarm run (SWR1): emits `running` state, launches `config.agents`
//     scripted agents at `launch_per_second` — agent n's pattern drawn from
//     `collision_dial` with `agentRandom(seed, n)` (SW1), one `rescale-energy` every
//     `rescale_every_s` while the dial is positive — takes `swarm.control` events (dial,
//     stop) and emits every change. It ends on `stop`, on the kill switch, or by itself
//     ATTEMPT_TIMEOUT_MS after its last regular agent was due (`runTick`).
//
// The step is the outbox row (EV2a): `emitSwarmState` throws while a pool's Floor has not
// confirmed, and `step.do` retries with backoff — a step completes only when every delivery
// is confirmed. The swarm source has no per-pool counter of its own; each emit discovers the
// counter through the Floor's `gap` answer (see src/worker/swarm/deliver.ts).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type {
  SwarmControlEvent,
  SwarmEmitParams,
  SwarmRegisterPoolParams,
  SwarmRunParams,
} from "../../protocol/internal.ts";
import { notBuiltError } from "../not-built.ts";
import { emitSwarmState } from "../swarm/emit.ts";
import { launchAgent, launchId } from "../swarm/launch.ts";
import { patternById } from "../../swarm/pattern.ts";
import { dialPick } from "../../swarm/dial.ts";
import { agentRandom } from "../../swarm/prng.ts";
import { runTick } from "../../swarm/run-schedule.ts";
import { PUSH_BACKOFF_BASE_MS } from "../../protocol/constants.ts";

type SwarmParams = SwarmRegisterPoolParams | SwarmEmitParams | SwarmRunParams | { kind?: unknown };

/** EV2a's outbox row retried with backoff — a step completes only once the Floor confirmed. */
const EMIT_RETRY = {
  retries: { limit: 12, delay: PUSH_BACKOFF_BASE_MS, backoff: "exponential" as const },
};
/** One launch attempt is retried too — the same durable idempotency covers a replay. */
const LAUNCH_RETRY = {
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

/** `waitForEvent`'s timeout error is not exported; the engine names it. */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "WorkflowTimeoutError";
}

export class SwarmWorkflow extends WorkflowEntrypoint<Env> {
  override async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<void> {
    const params = (event.payload ?? {}) as SwarmParams;
    switch (params.kind) {
      case "register_pool":
      case "emit": {
        const patch = params.kind === "emit" ? ((params as SwarmEmitParams).patch ?? {}) : {};
        // The emit's commit `ts` is a step result, so a restart replays the same clock (EV5's
        // source-side `ts`), and a retried emit keeps one idempotent identity.
        const ts = await step.do<number>("ts", async () => Date.now());
        await step.do("emit", EMIT_RETRY, () => emitSwarmState(this.env, patch, ts));
        return;
      }
      case "run":
        return this.runLaunch(params as SwarmRunParams, step);
      default:
        return Promise.reject(notBuiltError());
    }
  }

  /** `run-<pool>`: the launch loop and its `swarm.state` emissions (SWR1, SWR4). */
  private async runLaunch(params: SwarmRunParams, step: WorkflowStep): Promise<void> {
    const { pool, request_id } = params;
    let { agents, collision_dial } = params.config;
    const { seed, launch_per_second, think_ms, rescale_every_s } = params.config;
    const hold = new Set(params.config.hold_before_submit ?? []);

    let emits = 0;
    /** One emission: a stable `ts` step result, then the fan-out as the retried row. */
    const emit = async (patch: { running?: boolean; agents?: number; collision_dial?: number }) => {
      const ts = await step.do<number>(`emit-ts-${emits}`, async () => Date.now());
      await step.do(`emit-${emits}`, EMIT_RETRY, () => emitSwarmState(this.env, patch, ts));
      emits += 1;
    };

    /** One scripted agent; `seq` is its draw-stream index (SW1) and its name's `n`. */
    const launch = (seq: number, patternId: string) => {
      const pattern = patternById(patternId);
      if (pattern === undefined) throw new Error(`swarm run: unknown pattern ${patternId}`);
      return step.do(`launch-${seq}`, LAUNCH_RETRY, async () => {
        const rand = agentRandom(seed, seq);
        const truth = pattern.truthOf === undefined ? pattern.truth : pattern.truthOf(rand);
        const result = await launchAgent(this.env, {
          pool,
          attemptId: launchId("a_", request_id, seq),
          intentId: launchId("i_", request_id, seq),
          pattern: { id: pattern.id, intent: pattern.intent, truth },
          seed,
          agentN: seq,
          hold: hold.has(pattern.id),
          thinkMs: think_ms,
        });
        if (!result.ok) throw new Error(`launch ${seq}: ${result.code}`);
      });
    };

    const startMs = await step.do<number>("start", async () => Date.now());
    await emit({ running: true, agents, collision_dial });

    // Pace one-second ticks: each waits on a `swarm.control` event; the timeout is the tick.
    // `seq` is the draw-stream index every launch takes (SW1); `regular` counts only the
    // run's `agents`, so a rescale-energy launch never fills the configured quota. Each tick
    // costs two steps (the wait and one for the kill switch and the clock) plus one per launch,
    // well inside a Workflow instance's step limit for a run that ends by itself (`runTick`).
    let regular = 0;
    let rescaled = 0;
    let seq = 0;
    let tick = 0;
    let doneAt: number | null = null;
    while (true) {
      let control: SwarmControlEvent["payload"] | null = null;
      try {
        const event: WorkflowStepEvent<SwarmControlEvent["payload"]> = await step.waitForEvent(`control-${tick}`, {
          type: "swarm.control",
          timeout: "1 second",
        });
        control = event.payload ?? null;
      } catch (cause) {
        if (!isTimeout(cause)) throw cause;
      }
      tick += 1;

      if (control?.op === "dial") {
        collision_dial = control.collision_dial;
        await emit({ collision_dial });
      } else if (control?.op === "agents") {
        agents = Math.max(regular, control.agents);
        await emit({ agents });
      } else if (control?.op === "stop") {
        break;
      }

      // The kill switch stops launching (SE10); the clock of this tick is a step result, so a
      // replay after a restart sees the same schedule.
      const { stop, now } = await step.do<{ stop: boolean; now: number }>(`tick-${tick}`, async () => ({
        stop: await killed(this.env),
        now: Date.now(),
      }));
      if (stop) break;

      const due = runTick({
        now,
        startMs,
        agents,
        launchPerSecond: launch_per_second,
        collisionDial: collision_dial,
        rescaleEverySecs: rescale_every_s,
        doneAt,
      });
      doneAt = due.doneAt;
      if (due.ended) break;
      while (regular < due.regularDue) {
        const pattern = dialPick(collision_dial, agentRandom(seed, seq));
        await launch(seq, pattern.id);
        seq += 1;
        regular += 1;
      }
      // 10.4's launch schedule: one rescale-energy every rescale_every_s while d > 0.
      while (rescaled < due.rescaleDue) {
        await launch(seq, "rescale-energy");
        seq += 1;
        rescaled += 1;
      }
    }

    await emit({ running: false });
  }
}
