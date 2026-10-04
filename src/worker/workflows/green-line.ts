import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";

/** Stub (Slice 0). Verifies head and advances the green line. The git lane builds this class in Slice 14. */
export class GreenLineWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>): Promise<never> {
    return Promise.reject(notBuiltError());
  }
}
