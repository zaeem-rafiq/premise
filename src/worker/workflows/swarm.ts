import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";

type SwarmParams = { kind?: unknown };

/** Stub (Slice 0). Launches scripted agents. The swarm lane builds this class in Slice 8.
 *
 * A `register_pool` instance already records its registration by existing — its id names pool
 * and request — so `run` completes it at once. A rejecting run never settles into a terminal
 * state: the engine keeps the instance alive and the runtime reports the request hung, on every
 * pool creation. Every other kind is the swarm lane's to build, and still answers `not_built`. */
export class SwarmWorkflow extends WorkflowEntrypoint<Env> {
  override run(event: Readonly<WorkflowEvent<unknown>>): Promise<void> {
    const params = (event.payload ?? {}) as SwarmParams;
    if (params.kind === "register_pool") return Promise.resolve();
    return Promise.reject(notBuiltError());
  }
}
