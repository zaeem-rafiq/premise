// PV1-PV3: publish frozen preview commits after the card transaction. Preview refs are
// immutable: an existing different commit is an error, never a ref to overwrite. These
// pushes share the plain-merge repository, but neither its main ref nor the landing outbox.

import { ZERO_OID } from "../../core/git/objects.ts";
import { PUSH_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { PreviewBuild, PreviewDoneInput, PreviewPush, PreviewResult } from "../../protocol/internal.ts";
import type { Env } from "../env.ts";
import { receivePackPusher } from "../adapters/pusher/pusher.ts";
import { artifactsTokenSource } from "../adapters/token-source/token-source.ts";
import { poolRepoName } from "../repos.ts";
import { recordTrunkError } from "./after-commit.ts";
import { runPush } from "./push-runner.ts";
import type { PushDeps } from "./push.ts";
import { metaGet, sqlOf } from "./sql.ts";

export type PreviewApply = (name: "preview" | "preview_done", input: PreviewDoneInput) => Promise<unknown>;

// An alarm may yield to another request while the push is in flight. Only its first run owns
// the result; the frozen pending records make an eviction and subsequent retry safe as well.
const running = new Set<DurableObjectState>();

function alreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ALREADY_EXISTS";
}

async function publish(pool: string, preview: PreviewPush, deps: PushDeps): Promise<PreviewResult | null> {
  const success = { submit_id: preview.submit_id, commit: preview.commit };
  const conflict = { submit_id: preview.submit_id, error: "preview_ref_conflict" };
  let target;
  try {
    target = await deps.tokenSource.writeTarget(pool);
    const refs = await deps.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [preview.ref],
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const current = refs[preview.ref] ?? null;
    if (current === preview.commit) return success;
    if (current !== null) return conflict;
  } catch {
    return null;
  }

  try {
    const outcome = await runPush(
      {
        pool_id: pool,
        updates: [{ ref: preview.ref, old: ZERO_OID, new: preview.commit }],
        pack: preview.pack,
      },
      deps,
    );
    target = outcome.target;
    if (outcome.result.ok) return success;
  } catch {
    // A lost response can still mean the ref moved. The follow-up advertisement decides,
    // using only fixed error codes below; raw errors may contain a remote or a token.
  }

  try {
    const refs = await deps.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [preview.ref],
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const after = refs[preview.ref] ?? null;
    if (after === preview.commit) return success;
    if (after !== null) return conflict;
  } catch {
    // A failed read leaves the frozen pending commit for the next backed-off retry.
  }
  return null;
}

export async function runPreviewJob(
  env: Env,
  ctx: DurableObjectState,
  apply: PreviewApply,
  deps?: Partial<PushDeps>,
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  try {
    const pool = metaGet(sqlOf(ctx), "pool_id");
    if (pool === null) return;
    const build = (await apply("preview", {})) as PreviewBuild;
    if (build.state === "idle") return;
    const results = [...build.errors];
    const retried: string[] = [];
    const pools = env.POOLS as Artifacts | undefined;
    if (pools === undefined) {
      // PV3/FR32: absence of a publishing binding is a visible preview failure. It must not
      // leave the card waiting forever, or stop the owner from using Land and Decline.
      results.push(...build.previews.map(({ submit_id }) => ({ submit_id, error: "preview_unavailable" })));
    } else if (build.previews.length > 0) {
      let available = true;
      try {
        await pools.create(poolRepoName(pool, "plain"), { description: `premise plain-merge ${pool}` });
      } catch (cause) {
        available = alreadyExists(cause);
      }
      if (!available) {
        retried.push(...build.previews.map(({ submit_id }) => submit_id));
      } else {
        const d: PushDeps = {
          tokenSource: artifactsTokenSource(pools, { repoForPool: (p) => poolRepoName(p, "plain") }),
          pusher: receivePackPusher(),
          ...deps,
        };
        for (const preview of build.previews) {
          const result = await publish(pool, preview, d);
          if (result === null) retried.push(preview.submit_id);
          else results.push(result);
        }
      }
    }
    // The core owns each submit's retry count and backoff. This second transaction updates
    // only still-current cards, so a card closed during a push stays closed (PV3).
    await apply("preview_done", { epoch: build.epoch, results, dropped: build.dropped, retried });
    if (retried.length > 0) recordTrunkError(ctx, "preview", "transport");
  } finally {
    running.delete(ctx);
  }
}
