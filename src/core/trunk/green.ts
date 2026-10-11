// src/core/trunk/green.ts — the engine half of the green line (01-core 11.5, GR1 to GR5a).
// The `green` timer (3.3) asks `greenStart` for the next commit to verify; the worker verifies it
// off the landing path, moves `refs/heads/green` when it passed (GR2a), and `greenDone` applies the
// answer: `green.verified`, and on a pass `green.advanced` and `pool.state` (EM1). Everything here
// is synchronous and transaction-bound (SY2, AL4): no remote read, no clock but the pool's own.

import { GREEN_LOG_MAX_CHARS, GREEN_MIN_INTERVAL_MS, GREEN_TIMEOUT_MS } from "../../protocol/constants.ts";
import { GREEN_CHECK_NAMES, SELFTEST_CODES, type VerifyResult } from "../../protocol/green.ts";
import { redact } from "../../protocol/redact.ts";
import { emitPoolState, event, metaWrite } from "./events.ts";
import { scheduleTick } from "./intents.ts";
import type { Pool, UndoRequest } from "./sets.ts";
import { planUndo } from "../undo/plan.ts";

/** `meta.green_inflight`: the one verification in flight (GR1). `run` is 2 for GR3's second run. */
type Inflight = { seq: number; commit: string; run: 1 | 2; started_at: number };

/** What the runner verifies: the commit, the files it was built from, and the green commit's files
 * (GR5a counts only findings the green commit does not have). Entries, not maps: the answer leaves
 * the transaction and the pool's own maps must not be shared with work that runs after it. */
export type GreenStart =
  | { state: "idle" }
  | {
      state: "verify";
      pool_id: string;
      seq: number;
      commit: string;
      run: 1 | 2;
      /** The value `refs/heads/green` holds for the compare-and-swap; "" when it does not exist. */
      old_green: string;
      /** An imported pool (`app` "", IR7): the imported language set, and no CK6 globals check. */
      imported: boolean;
      files: Array<[string, string]>;
      green_files: Array<[string, string]>;
    };

export type GreenDoneInput = { seq: number; commit: string; run: 1 | 2; result: VerifyResult };

const INFLIGHT = "green_inflight";
const RERUN = "green_rerun";
const STARTED = "green_started_at";
const LAST = "green_last";

function readJson<T>(pool: Pool, key: string): T | null {
  const raw = pool.meta.get(key);
  if (raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function putTimer(pool: Pool, dueAt: number, replace: boolean): void {
  pool.sql.exec(
    `INSERT OR ${replace ? "REPLACE" : "IGNORE"} INTO timers (kind, key, due_at) VALUES ('green', '', ?)`,
    dueAt,
  );
}

/** GR1: the next run starts no earlier than `GREEN_MIN_INTERVAL_MS` after the previous start. */
function earliestStart(pool: Pool): number {
  const started = Number(pool.meta.get(STARTED) ?? "");
  return Number.isFinite(started) && started > 0 ? Math.max(pool.now(), started + GREEN_MIN_INTERVAL_MS) : pool.now();
}

/** Whether this build runs a green line: the static runtime (part 14a) or the isolate (14b). */
export function runsGreen(pool: Pool): boolean {
  return pool.featuresGreen === "static" || pool.featuresGreen === "full";
}

/** GR3 (part 14b): a confirmed red queues one request of cause `revert` for every live landing of
 * kind `change` in `(green_seq, s]`, planned like an undo with *R* starting from that range. It
 * lands as one commit of kind `revert` in the next tick and reopens every attempt in *R* with a
 * heads-up whose `check` items carry only the failing names and codes (GR8). */
function queueRevert(pool: Pool, seq: number, checks: VerifyResult["checks"]): void {
  const greenSeq = Number(pool.meta.get("green_seq") ?? "0");
  const range = pool.landings
    .filter((l) => l.kind === "change" && l.undone_by === null && l.seq > greenSeq && l.seq <= seq)
    .map((l) => l.seq)
    .sort((a, b) => a - b);
  if (range.length === 0) return;
  // A take-back already queued owns these landings until the next tick (as UN5's confirm).
  if (pool.undoQueue.some((q) => (q.reverted ?? [q.target_seq]).some((s) => range.includes(s)))) return;
  const plan = planUndo(pool, range[0]!, pool.files, range);
  const request: UndoRequest = {
    request_id: `green-revert-${seq}`,
    target_seq: range[0]!,
    cause: "revert",
    state: "queued",
    requested_by: "green",
    reverted: plan.reverted,
    checks: checks.filter((c) => !c.ok).map((c) => ({ name: c.name, code: c.code ?? "" })),
  };
  pool.undoQueue.push(request);
  pool.undoLog.set(request.request_id, request);
  pool.dirtyUndo.add(request.request_id);
  scheduleTick(pool);
  event(pool, "undo.planned", {
    request_id: request.request_id,
    cause: "revert",
    target_seq: request.target_seq,
    reverted: plan.reverted,
    reopened: plan.reverted.flatMap((s) => {
      const id = pool.landings.find((l) => l.seq === s)?.attempt_id;
      return id == null ? [] : [id];
    }),
    kept_readers: plan.kept,
  });
}

/** The landing a run would verify (GR1a): the newest one confirmed on `main`. */
function landed(pool: Pool): { seq: number; commit: string } {
  return { seq: Number(pool.meta.get("landed_seq") ?? "0"), commit: pool.meta.get("landed_commit") ?? "" };
}

/** The newest seq the green line has already judged: its own `green_seq`, or a confirmed red
 * (GR1a: a commit that failed confirmed is not verified again). */
function judgedThrough(pool: Pool): number {
  const green = Number(pool.meta.get("green_seq") ?? "0");
  const last = readJson<{ seq: number; ok: boolean; confirmed: boolean }>(pool, LAST);
  return last !== null && !last.ok && last.confirmed ? Math.max(green, last.seq) : green;
}

/** Arms the `green` timer after `batch.pushed` (GR1). A run in flight re-arms on its own answer,
 * and an armed timer is never moved earlier: GR1 keeps one verification in flight. */
export function armGreen(pool: Pool): void {
  if (!runsGreen(pool)) return;
  if (readJson<Inflight>(pool, INFLIGHT) !== null) return;
  putTimer(pool, earliestStart(pool), false);
}

/** The `green` timer's entry (GR1, GR1a): the next commit to verify, or `idle`. */
export function greenStart(pool: Pool): GreenStart {
  if (!runsGreen(pool)) return { state: "idle" };
  if ((pool.meta.get("pool_state") ?? "ready") === "rebuilding") return { state: "idle" };
  const now = pool.now();
  const inflight = readJson<Inflight>(pool, INFLIGHT);
  if (inflight !== null) {
    const abandonAt = inflight.started_at + GREEN_TIMEOUT_MS + GREEN_MIN_INTERVAL_MS;
    if (now < abandonAt) {
      // A run is in flight (GR1). Its watchdog row was claimed to bring this call here: put it back.
      putTimer(pool, abandonAt, true);
      return { state: "idle" };
    }
    metaWrite(pool, INFLIGHT, null); // GR1a: abandoned by a restarted Trunk — the next run starts
  }

  const rerun = readJson<{ seq: number; commit: string }>(pool, RERUN);
  let target: { seq: number; commit: string; run: 1 | 2 };
  if (rerun !== null) {
    target = { ...rerun, run: 2 };
  } else {
    const head = landed(pool);
    if (head.seq <= judgedThrough(pool) || head.commit === "") return { state: "idle" };
    target = { ...head, run: 1 };
  }

  const at = earliestStart(pool);
  if (now < at) {
    putTimer(pool, at, true);
    return { state: "idle" };
  }

  const greenSeq = Number(pool.meta.get("green_seq") ?? "0");
  metaWrite(pool, INFLIGHT, JSON.stringify({ ...target, started_at: now } satisfies Inflight));
  metaWrite(pool, STARTED, now);
  // The watchdog (GR1a): the answer replaces this row; a Trunk that restarts mid-run finds it.
  putTimer(pool, now + GREEN_TIMEOUT_MS + GREEN_MIN_INTERVAL_MS, true);
  return {
    state: "verify",
    pool_id: pool.meta.get("pool_id") ?? "",
    seq: target.seq,
    commit: target.commit,
    run: target.run,
    old_green: pool.meta.get("green_commit") ?? "",
    imported: pool.meta.get("app") === "",
    files: [...pool.fileMapAt(target.seq)],
    green_files: [...pool.fileMapAt(greenSeq)],
  };
}

/** GR8: only names of the fixed list, a code only on a failed check, and only a fixed code. A
 * result that carries anything else is refused whole — its free text must not reach the stream. */
export function validChecks(checks: VerifyResult["checks"]): boolean {
  const names = new Set<string>(GREEN_CHECK_NAMES);
  return checks.every((c) => {
    if (!names.has(c.name) || typeof c.ok !== "boolean") return false;
    if (c.ok) return c.code === undefined;
    if (c.name === "selftest_ran") return (SELFTEST_CODES as readonly string[]).includes(c.code ?? "");
    return c.code === `${c.name}:failed`;
  });
}

/** GR4: a result for a commit that is no longer the landing of its seq on `main`, or older than
 * `green_seq`, is discarded. */
function current(pool: Pool, seq: number, commit: string): boolean {
  if (seq < Number(pool.meta.get("green_seq") ?? "0")) return false;
  if (seq === 0) return commit === (pool.meta.get("landed_commit") ?? "") && landed(pool).seq === 0;
  const l = pool.landings.find((x) => x.seq === seq);
  return l !== undefined && l.commit_oid === commit && l.pushed_at !== null;
}

/** The answer of one run (GR2, GR3, GR3b, GR4, GR7). On a pass the worker has already moved
 * `refs/heads/green` to `commit` (GR2a). `aborted` is a run that produced no verdict — its files
 * could not be read or its ref update failed — which emits nothing and is tried again at
 * `retry_at` (GR1a). */
export function greenDone(
  pool: Pool,
  input: GreenDoneInput | { seq: number; commit: string; aborted: true; retry_at: number },
): Record<string, unknown> {
  const inflight = readJson<Inflight>(pool, INFLIGHT);
  // LP6's compare-and-swap: an answer for a run that is not the one in flight changes nothing.
  if (inflight === null || inflight.seq !== input.seq || inflight.commit !== input.commit) {
    return { ok: false, error: { code: "stale" } };
  }
  metaWrite(pool, INFLIGHT, null);

  if ("aborted" in input) {
    putTimer(pool, Math.max(input.retry_at, earliestStart(pool)), true);
    return { ok: true, applied: "aborted" };
  }

  const { result } = input;
  if (!current(pool, input.seq, input.commit)) {
    metaWrite(pool, RERUN, null);
    rearm(pool);
    return { ok: true, applied: "discarded" };
  }
  if (!validChecks(result.checks) || result.seq !== input.seq || result.commit !== input.commit) {
    // Never emitted: a verifier that broke GR8 is a fault of the build, not a red green line.
    rearm(pool);
    return { ok: false, error: { code: "invalid_result" } };
  }

  const confirmed = result.ok || input.run === 2;
  event(pool, "green.verified", {
    seq: input.seq,
    commit: input.commit,
    ok: result.ok,
    runtime: result.runtime,
    checks: result.checks,
    ms: result.duration_ms,
    confirmed,
  });
  // GR7: the log is stored with the result for the owner, redacted and bounded; never an event.
  metaWrite(
    pool,
    LAST,
    JSON.stringify({
      seq: input.seq,
      commit: input.commit,
      ok: result.ok,
      confirmed,
      runtime: result.runtime,
      checks: result.checks,
      log: redact(result.log).slice(0, GREEN_LOG_MAX_CHARS),
    }),
  );

  if (result.ok) {
    metaWrite(pool, RERUN, null);
    metaWrite(pool, "green_seq", input.seq);
    metaWrite(pool, "green_commit", input.commit);
    event(pool, "green.advanced", { seq: input.seq, commit: input.commit });
    emitPoolState(pool); // EM1: `green_seq` moved
  } else if (input.run === 1) {
    // GR3: a first failed run changes nothing else; the same commit is run once more.
    metaWrite(pool, RERUN, JSON.stringify({ seq: input.seq, commit: input.commit }));
  } else {
    // GR3: confirmed. The isolate build (part 14b) takes the range back; the static build queues
    // no revert (GR3b). Either way the next landing is verified when it comes.
    metaWrite(pool, RERUN, null);
    if (pool.featuresGreen === "full") queueRevert(pool, input.seq, result.checks);
  }
  rearm(pool);
  return { ok: true, applied: result.ok ? "advanced" : confirmed ? "red" : "rerun" };
}

/** After an answer: the next run is due when a rerun waits or a newer landing is on `main`. */
function rearm(pool: Pool): void {
  const more = readJson(pool, RERUN) !== null || landed(pool).seq > judgedThrough(pool);
  if (more) putTimer(pool, earliestStart(pool), true);
  else pool.sql.exec("DELETE FROM timers WHERE kind = 'green' AND key = ''");
}
