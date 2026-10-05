// src/worker/trunk/plain-runner.ts — the `plain` timer's work (01-core 11.7, PM1-PM7, 3.3).
// One run asks the engine's `plain` entry for the next commit of `<pool>-plain` (the replay's
// result, already packed), ensures the repository exists on Artifacts, reads its `main`, and:
//
//   - `main` already holds the commit     → `plain_done` applies the answer (LP6's lost answer);
//   - `main` holds the commit's parent    → one receive-pack push, then `plain_done` (PM6);
//   - `main` holds anything else          → the entry is called again with `parent_override` —
//     the same tree re-anchored on what the remote really has — and that commit is pushed.
//
// A refused or failed push is retried on the push backoff off `meta.plain_tries` (PM7's own
// retry state — it shares nothing with the landing outbox, and a `pool.paused` does not exist
// for it). Every failure leaves a `trunk.error` with a fixed code and nothing else (SE5b, BP7).
// No remote call happens inside a transaction (AL4): the entry's transaction runs first, the
// network second, the apply's transaction last — a crash between them replays the whole step,
// and `plain_done`'s compare-and-swap makes a second application a no-op (LP6).

import { PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS, PUSH_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { ErrCode } from "../../protocol/events.ts";
import type { Env } from "../env.ts";
import { metaGet, metaSet, sqlOf, timerPut } from "./sql.ts";
import { recordTrunkError } from "./after-commit.ts";
import { artifactsTokenSource } from "../adapters/token-source/token-source.ts";
import { receivePackPusher } from "../adapters/pusher/pusher.ts";
import { runPush } from "./push-runner.ts";
import { poolRepoName } from "../repos.ts";
import { ZERO_OID } from "../../core/git/objects.ts";
import type { PlainBuild } from "../../core/trunk/plain.ts";
import type { PushDeps } from "./push.ts";

const MAIN_REF = "refs/heads/main";
/** PM7's own failure count — the landing outbox's `tries` is not the plain pool's to share. */
const TRIES_KEY = "plain_tries";

export type PlainApply = (name: "plain" | "plain_done", input: Record<string, unknown>) => Promise<unknown>;

type RemoteMain = "old" | "new" | "other";

function artifactsCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const code = (cause as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The ref's LP5 value against the pending commit: `new` is the commit already applied, `old`
 * the parent it can fast-forward from, `other` anything else (a pushed-but-unapplied commit). */
function refValue(read: string | null, pending: { commit: string; parent: string }): RemoteMain {
  if (read === pending.commit) return "new";
  if (read === pending.parent || (read === null && pending.parent === "")) return "old";
  return "other";
}

/** The independent retry: `plain_tries` counts up, the `plain` timer is re-armed at the push
 * backoff (9.6), and a `trunk.error` carries the fixed code — never a raw reason (SE5b). */
function scheduleRetry(ctx: DurableObjectState, code: ErrCode, now: number): void {
  const sql = sqlOf(ctx);
  sql.transaction(() => {
    const tries = Number(metaGet(sql, TRIES_KEY) ?? "0") + 1;
    metaSet(sql, TRIES_KEY, tries);
    timerPut(sql, "plain", "", now + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS));
  });
  recordTrunkError(ctx, "plain", code);
}

/** A run that finished — done or idle — forgets the failure count it started under. */
function clearTries(ctx: DurableObjectState): void {
  sqlOf(ctx).transaction(() => sqlOf(ctx).exec("DELETE FROM meta WHERE k = ?", TRIES_KEY));
}

/** The object a `runPlainJob` call owns until its answer lands — like `pushing` in push.ts, a
 * reentrant call returns at once rather than re-push the pending commit ahead of its apply. */
const running = new Set<DurableObjectState>();

export async function runPlainJob(
  env: Env,
  ctx: DurableObjectState,
  apply: PlainApply,
  deps?: Partial<PushDeps>,
  /** The time the retry schedule reads; absent, the wall clock. The alarm's `?now=` test path
   * hands its override through so a retry is drivable without sleeping for the real backoff. */
  now?: number,
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  try {
    await runPlainJobInner(env, ctx, apply, deps, now ?? Date.now());
  } finally {
    running.delete(ctx);
  }
}

async function runPlainJobInner(
  env: Env,
  ctx: DurableObjectState,
  apply: PlainApply,
  deps: Partial<PushDeps> | undefined,
  now: number,
): Promise<void> {
  const sql = sqlOf(ctx);
  const pool = metaGet(sql, "pool_id");
  // A wiped or never-created pool has nothing to build — and a rebuild's own timer arm brings
  // the job back when the pool exists again (3.6).
  if (pool === null) return;
  // A deployment without Artifacts has nowhere to push: the pool still lands, it just never
  // gets a plain-merge mirror (the local test deployment is exactly this).
  const pools = env.POOLS as Artifacts | undefined;
  if (pools === undefined) return;
  const d: PushDeps = {
    tokenSource: artifactsTokenSource(pools, { repoForPool: (p) => poolRepoName(p, "plain") }),
    pusher: receivePackPusher(),
    ...deps,
  };

  let build = (await apply("plain", {})) as PlainBuild;
  if (build.state === "idle") {
    clearTries(ctx);
    return;
  }

  // `<pool>-plain` is created here, on the first build, rather than in the pool-create route:
  // the route cannot know the pool will ever land, an empty pool needs no mirror, and the
  // runner is the only code path that knows the repository is needed (11.7 leaves the moment
  // open). The creation token is discarded — Trunk pushes through `writeTarget`'s own mints.
  const name = poolRepoName(pool, "plain");
  try {
    await pools.create(name, { description: `premise plain-merge ${pool}` });
  } catch (cause) {
    if (artifactsCode(cause) !== "ALREADY_EXISTS") throw cause;
  }

  let target;
  try {
    target = await d.tokenSource.writeTarget(pool);
  } catch (cause) {
    // BP7: the error's name and message only — never the target, which carries secret material.
    console.error("plain writeTarget failed", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
    scheduleRetry(ctx, "transport", now);
    return;
  }

  // The remote's `main` is read on every run — a lost answer can leave the pending commit
  // already applied (LP6), and a remote the platform rebuilt under us is what `other` heals.
  let read: string | null;
  try {
    const refs = await d.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [MAIN_REF],
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    read = refs[MAIN_REF] ?? null;
  } catch {
    scheduleRetry(ctx, "transport", now);
    return;
  }

  let value = refValue(read, build);
  if (value === "other") {
    // The remote's `main` moved past the pending parent — typically the pending commit's own
    // predecessor pushed by a run whose answer never landed. The same tree is re-anchored on
    // what the remote really holds; the push that follows is then a fast-forward.
    build = (await apply("plain", { parent_override: read ?? "" })) as PlainBuild;
    if (build.state === "idle") {
      clearTries(ctx);
      return;
    }
    value = refValue(read, build); // the override made `read` the parent — "old"
  }

  if (value === "new") {
    clearTries(ctx);
    const r = await apply("plain_done", { commit: build.commit, remote: target.remote });
    if (typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === false) {
      // The pending this run applied for is no longer the pending — a rebuild wiped it. The
      // next arm rebuilds the record; nothing to retry against a superseded commit.
      return;
    }
    return;
  }

  // "old": one receive-pack push of the pending commit (9.5's pack code made its bytes).
  let outcome;
  try {
    outcome = await runPush(
      {
        pool_id: pool,
        updates: [{ ref: MAIN_REF, old: build.parent === "" ? ZERO_OID : build.parent, new: build.commit }],
        pack: build.pack,
      },
      { tokenSource: d.tokenSource, pusher: d.pusher },
    );
  } catch (cause) {
    console.error(
      "plain push transport failed",
      cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
    );
    scheduleRetry(ctx, "transport", now);
    return;
  }
  const { result } = outcome;

  if (!result.ok) {
    // LP5's follow-up read: a refusal can still have moved the ref — the applied check ends
    // the retry cleanly, a refusal that held counts toward the backoff either way.
    let after: string | null = null;
    try {
      const refs = await d.pusher.readRefs({
        remote: outcome.target.remote,
        token: outcome.target.token,
        refs: [MAIN_REF],
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      after = refs[MAIN_REF] ?? null;
    } catch {
      /* the read failing is the same retry as the push failing */
    }
    if (after === build.commit) {
      clearTries(ctx);
      await apply("plain_done", { commit: build.commit, remote: outcome.target.remote });
      return;
    }
    scheduleRetry(ctx, result.kind === "rejected" ? "rejected" : result.code, now);
    return;
  }

  clearTries(ctx);
  const r = await apply("plain_done", { commit: build.commit, remote: outcome.target.remote });
  if (typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === false) {
    // Pushed, but the pending was superseded before the apply landed — the next arm covers it.
    return;
  }
}
