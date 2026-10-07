// The Swarm launcher (01-core SWR1, EM6, EV2a): the `SWARM` Workflow of the brief. Three
// instance kinds run here:
//
//   register_pool — pool creation's registration (PL1): emits the current `swarm.state` to
//     every registered pool, so the new stream receives it on its own `swarm` counter.
//   emit          — one `swarm.state` emission a route asked for (a dial change or a stop
//     with no live run): durable at-least-once delivery as a retried step.
//   run           — a Swarm run (SWR1): the launch loop lives in src/worker/swarm/run.ts —
//     one `tick-<n>` step per tick launches every due agent at once, so the step count grows
//     with the ticks and not with the agents.
//
// The step is the outbox row (EV2a): `emitSwarmState` throws while a pool's Floor has not
// confirmed, and `step.do` retries with backoff — a step completes only when every delivery
// is confirmed. The swarm source has no per-pool counter of its own; each emit discovers the
// counter through the Floor's `gap` answer (see src/worker/swarm/deliver.ts).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { SwarmEmitParams, SwarmRegisterPoolParams, SwarmRunParams } from "../../protocol/internal.ts";
import { notBuiltError } from "../not-built.ts";
import { emitSwarmState } from "../swarm/emit.ts";
import { runSwarmLaunch } from "../swarm/run.ts";
import { PUSH_BACKOFF_BASE_MS } from "../../protocol/constants.ts";

type SwarmParams = SwarmRegisterPoolParams | SwarmEmitParams | SwarmRunParams | { kind?: unknown };

/** EV2a's outbox row retried with backoff — a step completes only once the Floor confirmed. */
const EMIT_RETRY = {
  retries: { limit: 12, delay: PUSH_BACKOFF_BASE_MS, backoff: "exponential" as const },
};

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
        return runSwarmLaunch(this.env, params as SwarmRunParams, step);
      default:
        return Promise.reject(notBuiltError());
    }
  }
}
