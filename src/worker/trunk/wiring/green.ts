// The green line's worker half (01-core 11.5): the `green` timer's work, wired into Trunk's alarm
// like the plain-merge job. One run asks the engine's `green` entry for the next commit (GR1,
// GR1a), verifies it off the landing path with the build's runtime (GR5: the isolate's self-test
// when `features.green` is "full", S4a; the static checks of GR5a otherwise and for an imported
// pool, which has no self-test), moves `refs/heads/green` by compare-and-swap when it passed (GR2, GR2a), and hands the
// answer to `green_done` (GR3, GR4). A run that cannot read or cannot move the ref emits nothing
// and is retried on the push backoff with a `trunk.error` of a fixed code (SE5b, BP7). No remote
// call happens inside a transaction (AL4); a verification never blocks or slows a landing.

import { PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS, PUSH_TIMEOUT_MS } from "../../../protocol/constants.ts";
import type { VerifyResult } from "../../../protocol/green.ts";
import type { ErrCode } from "../../../protocol/events.ts";
import type { Verifier } from "../../../protocol/ports.ts";
import type { GreenStart } from "../../../core/trunk/green.ts";
import { buildPack } from "../../../core/git/pack.ts";
import { ZERO_OID } from "../../../core/git/objects.ts";
import type { Env } from "../../env.ts";
import { artifactsTokenSource } from "../../adapters/token-source/token-source.ts";
import { receivePackPusher } from "../../adapters/pusher/pusher.ts";
import { staticVerifier } from "../../adapters/verifier/static.ts";
import { isolateVerifier } from "../../adapters/verifier/isolate.ts";
import { FEATURES } from "../../../config/features.ts";
import { recordTrunkError } from "../after-commit.ts";
import { runPush } from "../push-runner.ts";
import type { PushDeps } from "../push.ts";
import { metaGet, metaSet, sqlOf } from "../sql.ts";

const GREEN_REF = "refs/heads/green";
/** The green line's own failure count for the backoff: it shares nothing with the landing outbox. */
const TRIES_KEY = "green_tries";

export type GreenApply = (name: "green" | "green_done", input: Record<string, unknown>) => Promise<unknown>;

export type GreenDeps = PushDeps & {
  /** The verifier for one start answer; default: the static runtime over the answer's files. */
  verifier?: (start: Extract<GreenStart, { state: "verify" }>) => Verifier;
};

type Verify = Extract<GreenStart, { state: "verify" }>;

/** The object a `runGreenJob` call owns until its answer lands: one verification in flight (GR1). */
const running = new Set<DurableObjectState>();

export async function runGreenJob(
  env: Env,
  ctx: DurableObjectState,
  apply: GreenApply,
  deps?: Partial<GreenDeps>,
  /** The time the retry schedule reads; absent, the wall clock (the alarm's `?now=` hands it). */
  now?: number,
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  try {
    await runGreenJobInner(env, ctx, apply, deps, now ?? Date.now());
  } finally {
    running.delete(ctx);
  }
}

/** A run that produced no verdict: nothing is emitted, the timer comes back at the backoff. */
async function abort(ctx: DurableObjectState, apply: GreenApply, start: Verify, code: ErrCode, now: number) {
  const sql = sqlOf(ctx);
  const tries = sql.transaction(() => {
    const n = Number(metaGet(sql, TRIES_KEY) ?? "0") + 1;
    metaSet(sql, TRIES_KEY, n);
    return n;
  });
  recordTrunkError(ctx, "green", code);
  await apply("green_done", {
    seq: start.seq,
    commit: start.commit,
    aborted: true,
    retry_at: now + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS),
  });
}

function clearTries(ctx: DurableObjectState): void {
  const sql = sqlOf(ctx);
  if (metaGet(sql, TRIES_KEY) === null) return;
  sql.transaction(() => sql.exec("DELETE FROM meta WHERE k = ?", TRIES_KEY));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}`.slice(0, 300) : "unknown";
}

/** GR2a: the ref command with an empty pack; one more try with the value the remote holds. */
async function moveGreenRef(d: PushDeps, start: Verify): Promise<"moved" | ErrCode> {
  const pack = buildPack([]);
  const send = (old: string) =>
    runPush(
      { pool_id: start.pool_id, updates: [{ ref: GREEN_REF, old, new: start.commit }], pack },
      { tokenSource: d.tokenSource, pusher: d.pusher },
    );
  let outcome = await send(start.old_green === "" ? ZERO_OID : start.old_green);
  if (outcome.result.ok) return "moved";
  if (outcome.result.kind !== "rejected") return outcome.result.code;
  const refs = await d.pusher.readRefs({
    remote: outcome.target.remote,
    token: outcome.target.token,
    refs: [GREEN_REF],
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const held = refs[GREEN_REF] ?? null;
  if (held === start.commit) return "moved"; // a lost answer of an earlier run (LP6)
  outcome = await send(held ?? ZERO_OID);
  if (outcome.result.ok) return "moved";
  return outcome.result.kind === "rejected" ? "rejected" : outcome.result.code;
}

async function runGreenJobInner(
  env: Env,
  ctx: DurableObjectState,
  apply: GreenApply,
  deps: Partial<GreenDeps> | undefined,
  now: number,
): Promise<void> {
  // A deployment without Artifacts has no remote to move the ref on: the pool still lands, it
  // just has no green line (the local deployment of `npm run dev:floor` is exactly this).
  const pools = env.POOLS as Artifacts | undefined;
  if (pools === undefined && (deps?.tokenSource === undefined || deps.pusher === undefined)) return;

  const start = (await apply("green", {})) as GreenStart;
  if (start.state !== "verify") return;

  const loader = (env as { LOADER?: WorkerLoader }).LOADER;
  const verifier =
    deps?.verifier?.(start) ??
    (FEATURES.green === "full" && !start.imported && loader !== undefined
      ? isolateVerifier({ seq: start.seq, commit: start.commit, files: new Map(start.files), loader })
      : undefined) ??
    staticVerifier({
      seq: start.seq,
      commit: start.commit,
      files: new Map(start.files),
      greenFiles: new Map(start.green_files),
      imported: start.imported,
    });
  let result: VerifyResult;
  try {
    result = await verifier.verify({ pool_id: start.pool_id, seq: start.seq, commit: start.commit });
  } catch (cause) {
    console.error("green verify failed", describe(cause)); // BP7: name and message only
    await abort(ctx, apply, start, "verifier_error", now);
    return;
  }

  if (result.ok) {
    const d: PushDeps = {
      tokenSource: deps?.tokenSource ?? artifactsTokenSource(pools!),
      pusher: deps?.pusher ?? receivePackPusher(),
    };
    let moved: "moved" | ErrCode;
    try {
      moved = await moveGreenRef(d, start);
    } catch (cause) {
      console.error("green ref update failed", describe(cause));
      moved = "transport";
    }
    if (moved !== "moved") {
      await abort(ctx, apply, start, moved, now);
      return;
    }
  }

  clearTries(ctx);
  await apply("green_done", { seq: start.seq, commit: start.commit, run: start.run, result });
}
