// The try conductor's Workflow (09-try TY9): one instance per try pool, its id the pool's name.
// The loop lives in src/worker/try/conduct.ts; this entrypoint only hands it the step. A build
// with `features.try` off runs nothing (TY1).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { FEATURES } from "../../config/features.ts";
import { notBuiltError } from "../not-built.ts";
import { runTry, type TryParams } from "../try/conduct.ts";

export class TryWorkflow extends WorkflowEntrypoint<Env> {
  override async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<string> {
    if (!FEATURES.try) return Promise.reject(notBuiltError());
    const params = (event.payload ?? {}) as Partial<TryParams>;
    if (typeof params.pool !== "string" || !params.pool.startsWith("try-")) return Promise.reject(notBuiltError());
    return runTry(this.env, { pool: params.pool }, step);
  }
}
