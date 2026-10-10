import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import { FEATURES } from "../../config/features.ts";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";

/**
 * ARCHIVE remains a successful no-op. S3 provisioning/retries belong to the singleton
 * gate alarm; AG5 checkpoints belong to the Agent alarm. The specification defines no
 * additional archive operation or deletion policy, so repositories are retained.
 * The disabled switch preserves the original not_built response.
 */
export class AttemptRepoWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>): Promise<{ ok: true }> {
    if (!FEATURES.attempt_repos) return Promise.reject(notBuiltError());
    return Promise.resolve({ ok: true });
  }
}
