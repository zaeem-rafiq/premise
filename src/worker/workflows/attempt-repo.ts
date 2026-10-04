import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";

/** Stub (Slice 0). Provisions and archives attempt repos. The agent lane builds this class in Slice 4, track 4D. */
export class AttemptRepoWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>): Promise<never> {
    return Promise.reject(notBuiltError());
  }
}
