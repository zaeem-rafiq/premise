import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";

/** Stub (Slice 0). Launches scripted agents. The swarm lane builds this class in Slice 8. */
export class SwarmWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>): Promise<never> {
    return Promise.reject(notBuiltError());
  }
}
