import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub (Slice 0). Launches scripted agents. The swarm lane builds this class in Slice 8. The
 * registration it already records is the instance itself — its id names pool and request — so
 * `run` completes at once. A rejecting run never settles into a terminal state: the engine keeps
 * the instance alive and the runtime reports the request hung, on every pool creation. */
export class SwarmWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>): Promise<void> {
    return Promise.resolve();
  }
}
