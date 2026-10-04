// The Trunk Durable Object's after-commit push work (01-core 9.6 to 9.8) and the heads-up
// delivery of HU5b. The engine decides by ref values (`push_ok`, `push_result`, `restart`
// entries); the shell owns the network, the token and the retry scheduling — `tries`,
// `next_try`, `last_error`, `rejects` on the outbox row and the `push`/`repush` timers.
//
// Every remote interaction happens outside a transaction (AL4); the decisions land in a
// second transaction through the engine's entries, so a crash between the push and the
// apply replays the whole step (LP6: same pack, compare-and-swap makes a second
// application impossible).

import { HEADS_UP_REPUSH_MS, PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import type { PushResult, RefUpdate } from "../../protocol/ports.ts";
import type { ErrCode } from "../../protocol/events.ts";
import type { Env } from "../env.ts";
import { appendEvent, sqlOf, timerPut } from "./sql.ts";
import { recordTrunkError } from "./after-commit.ts";
import { artifactsTokenSource } from "../adapters/token-source/token-source.ts";
import { receivePackPusher } from "../adapters/pusher/pusher.ts";
import { runPush, type PushBatch } from "./push-runner.ts";
import { ZERO_OID } from "../../core/git/objects.ts";
import { blobBytes } from "../../core/sync/bytes.ts";

const MAIN_REF = "refs/heads/main";
const NOTES_REF = "refs/notes/premise";

export type OutboxState = {
  batch_id: number;
  state: string;
  old_main: string;
  new_main: string;
  old_notes: string;
  new_notes: string;
  tries: number;
  rejects: number;
  next_try: number | null;
};

/** The unpushed batch — `pending` or `notes_pending` — or null (LP1: at most one). */
export function outboxRow(ctx: DurableObjectState): OutboxState | null {
  const row = sqlOf(ctx)
    .exec(
      `SELECT batch_id, state, old_main, new_main, old_notes, new_notes, tries, rejects, next_try
       FROM outbox WHERE state IN ('pending', 'notes_pending') ORDER BY batch_id LIMIT 1`,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    batch_id: Number(row.batch_id),
    state: String(row.state),
    old_main: String(row.old_main),
    new_main: String(row.new_main),
    old_notes: String(row.old_notes),
    new_notes: String(row.new_notes),
    tries: Number(row.tries),
    rejects: Number(row.rejects),
    next_try: row.next_try === null || row.next_try === undefined ? null : Number(row.next_try),
  };
}

/** The batch's stored pack bytes (LP6: the same bytes on every retry). */
function outboxPack(ctx: DurableObjectState, batch_id: number): Uint8Array {
  const chunks = sqlOf(ctx)
    .exec("SELECT bytes FROM outbox_chunks WHERE batch_id = ? ORDER BY i", batch_id)
    .toArray()
    .map((row) => blobBytes(row.bytes));
  const pack = new Uint8Array(chunks.reduce((n, b) => n + b.byteLength, 0));
  let off = 0;
  for (const chunk of chunks) {
    pack.set(chunk, off);
    off += chunk.byteLength;
  }
  return pack;
}

/** LP6's command list: the refs whose value is still old — `notes_pending` carries the notes
 * command only, `retry_main` (in-memory flag lost on restart — the extra command is harmless)
 * carries the main command only. A batch with no notes commit (the seed) carries only main. */
function commandsFor(outbox: OutboxState): RefUpdate[] {
  const updates: RefUpdate[] = [];
  const wantMain = outbox.state !== "notes_pending";
  const wantNotes = outbox.state !== "pending" || outbox.new_notes !== "";
  if (wantMain)
    updates.push({ ref: MAIN_REF, old: outbox.old_main === "" ? ZERO_OID : outbox.old_main, new: outbox.new_main });
  if (wantNotes && outbox.new_notes !== "") {
    updates.push({ ref: NOTES_REF, old: outbox.old_notes === "" ? ZERO_OID : outbox.old_notes, new: outbox.new_notes });
  }
  return updates;
}

type RefValue = "old" | "new" | "other";

/** LP5: map a read ref value against the batch's old and new. A missing ref is `old` when the
 * batch expected none (the seed's create). */
function refValue(read: string | null, oldV: string, newV: string): RefValue {
  if (read === newV && newV !== "") return "new";
  if (read === oldV || (read === null && oldV === "")) return "old";
  return "other";
}

/** The effect's deps: the lane's adapters, swapped for fakes in tests. */
export type PushDeps = {
  tokenSource: Parameters<typeof runPush>[1]["tokenSource"];
  pusher: ReturnType<typeof receivePackPusher>;
};

function defaultDeps(env: Env): PushDeps {
  return { tokenSource: artifactsTokenSource(env.POOLS), pusher: receivePackPusher() };
}

/** LP5a: `tries += 1`, `push` timer at the backoff, `push.retry` with the code — never raw text. */
function scheduleRetry(
  ctx: DurableObjectState,
  outbox: OutboxState,
  code: ErrCode,
  retryAfterMs: number | null = null,
): void {
  const sql = sqlOf(ctx);
  sql.transaction(() => {
    const tries = outbox.tries + 1;
    const delay = Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS);
    const next_try = Date.now() + Math.max(delay, retryAfterMs ?? 0);
    sql.exec(
      "UPDATE outbox SET tries = ?, next_try = ?, last_error = ? WHERE batch_id = ?",
      tries,
      next_try,
      code,
      outbox.batch_id,
    );
    timerPut(sql, "push", "", next_try);
    appendEvent(sql, Date.now(), {
      ts: Date.now(),
      pool: ctx.id.name ?? "",
      src: "trunk",
      type: "push.retry",
      batch_id: outbox.batch_id,
      tries,
      error: code,
      next_try_ms: Math.max(delay, retryAfterMs ?? 0),
    });
  });
}

/** Counts an LP5b poison candidate: a rejection after which both refs still had their old values. */
function countReject(ctx: DurableObjectState, outbox: OutboxState): void {
  sqlOf(ctx).transaction(() => {
    sqlOf(ctx).exec("UPDATE outbox SET rejects = rejects + 1 WHERE batch_id = ?", outbox.batch_id);
  });
  outbox.rejects += 1;
}

/** Runs an engine entry in its own transaction — the DO's door back into the engine after a push. */
export type ApplyPush = (name: "push_ok" | "push_result", input: unknown) => Promise<unknown>;

/**
 * Push the pending outbox once it is due: one `runPush`, then the LP5 decision — `push_ok` when
 * every ref reported ok; otherwise `readRefs` and `push_result` with the values. The entry's
 * answer names the next step (`repush`, `retry_main`, `retry_notes`, `mark_pushed`, `pause`).
 */
/** The object a `pushOutbox` call owns until its LP5 decision lands — a reentrant call (the
 * applied entry's own after-commit) returns at once, or it would re-push the same row before
 * the outer call writes `next_try` (an unbounded hot loop, not a retry). */
const pushing = new Set<DurableObjectState>();

export async function pushOutbox(
  env: Env,
  ctx: DurableObjectState,
  apply: ApplyPush,
  deps: PushDeps = defaultDeps(env),
): Promise<void> {
  if (pushing.has(ctx)) return;
  pushing.add(ctx);
  try {
    await pushOutboxInner(env, ctx, apply, deps);
  } finally {
    pushing.delete(ctx);
  }
}

async function pushOutboxInner(
  env: Env,
  ctx: DurableObjectState,
  apply: ApplyPush,
  deps: PushDeps,
): Promise<void> {
  const outbox = outboxRow(ctx);
  if (outbox === null) return;
  if (outbox.next_try !== null && outbox.next_try > Date.now()) return;

  let target;
  try {
    target = await deps.tokenSource.writeTarget(ctx.id.name ?? "");
  } catch (cause) {
    console.error("writeTarget failed", cause);
    scheduleRetry(ctx, outbox, "transport");
    recordTrunkError(ctx, "push", "transport");
    return;
  }
  // LP6's command list is the subset of the two commands whose ref still has its old value. On a
  // retry (`tries > 0`) the remote's own advertisement is what says which subset — a lost first
  // answer can leave the outbox behind the remote, and an in-memory per-ref flag does not survive
  // a restart. The read also ends the retry cleanly when both refs already moved (C50).
  let remote_main: RefValue;
  let remote_notes: RefValue;
  let updates = commandsFor(outbox);
  if (outbox.tries > 0) {
    let refs: Record<string, string | null>;
    try {
      refs = await deps.pusher.readRefs({
        remote: target.remote,
        token: target.token,
        refs: [MAIN_REF, NOTES_REF],
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      scheduleRetry(ctx, outbox, "transport");
      recordTrunkError(ctx, "push", "transport");
      return;
    }
    remote_main = refValue(refs[MAIN_REF] ?? null, outbox.old_main, outbox.new_main);
    remote_notes = refValue(refs[NOTES_REF] ?? null, outbox.old_notes, outbox.new_notes);
    updates = updates.filter((u) => (u.ref === MAIN_REF ? remote_main : remote_notes) === "old");
    if (updates.length === 0) {
      const action = await apply("push_result", { remote_main, remote_notes });
      if (action === "repush" || action === "retry_main" || action === "retry_notes") {
        scheduleRetry(ctx, outbox, "transport");
      }
      return;
    }
  }

  const batch: PushBatch = { pool_id: ctx.id.name ?? "", updates, pack: outboxPack(ctx, outbox.batch_id) };
  let outcome;
  try {
    outcome = await runPush(batch, { tokenSource: deps.tokenSource, pusher: deps.pusher });
  } catch (cause) {
    console.error("push transport", cause);
    scheduleRetry(ctx, outbox, "transport");
    recordTrunkError(ctx, "push", "transport");
    return;
  }
  target = outcome.target;
  const { result } = outcome;

  if (result.ok) {
    await apply("push_ok", {});
    return;
  }

  // LP5: every other answer is decided by the remote's own ref values, never the report's text.
  let refs: Record<string, string | null>;
  try {
    refs = await deps.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [MAIN_REF, NOTES_REF],
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // The read itself failed (LP5's last row): the outbox stands, the retry is scheduled.
    scheduleRetry(ctx, outbox, "transport");
    recordTrunkError(ctx, "push", "transport");
    return;
  }
  remote_main = refValue(refs[MAIN_REF] ?? null, outbox.old_main, outbox.new_main);
  remote_notes =
    outbox.new_notes === ""
      ? // A batch with no notes command (the seed): a missing or matching notes ref is "old"/"new".
        refValue(refs[NOTES_REF] ?? null, "", "")
      : refValue(refs[NOTES_REF] ?? null, outbox.old_notes, outbox.new_notes);

  const rejected = result.kind === "rejected";
  if (rejected && remote_main === "old" && remote_notes === "old") countReject(ctx, outbox);

  const action = await apply("push_result", { remote_main, remote_notes });
  switch (action) {
    case "mark_pushed":
    case "pause":
    case "none":
      return;
    case "repush":
    case "retry_main":
    case "retry_notes": {
      scheduleRetry(
        ctx,
        outbox,
        result.kind === "transport" ? result.code : "rejected",
        result.kind === "transport" ? result.retry_after_ms : null,
      );
      return;
    }
    default:
      recordTrunkError(ctx, "push", "reconcile_unknown");
  }
}

/**
 * LP7 — the DO's start-of-life reconcile, run once per object on the first request or alarm:
 * read both refs and hand the values to the `restart` entry, which applies the same table and
 * re-asks pending triage (TR6). No outbox row means nothing to reconcile.
 */
export async function reconcileOnStart(
  env: Env,
  ctx: DurableObjectState,
  restart: (input: { remote_main: RefValue; remote_notes: RefValue }) => Promise<void>,
  deps: PushDeps = defaultDeps(env),
): Promise<void> {
  const outbox = outboxRow(ctx);
  if (outbox === null) return;
  try {
    const target = await deps.tokenSource.writeTarget(ctx.id.name ?? "");
    const refs = await deps.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [MAIN_REF, NOTES_REF],
      signal: AbortSignal.timeout(30_000),
    });
    await restart({
      remote_main: refValue(refs[MAIN_REF] ?? null, outbox.old_main, outbox.new_main),
      remote_notes:
        outbox.new_notes === "" ? "old" : refValue(refs[NOTES_REF] ?? null, outbox.old_notes, outbox.new_notes),
    });
  } catch {
    // The remote is unreachable or the entry failed: the outbox stands and the next
    // start (an evicted object reconciles again) or a `push` timer retries.
    recordTrunkError(ctx, "restart", "transport");
  }
}

/**
 * HU5b: after the transaction commits, every heads-up the attempt's Agent has not received is
 * pushed — all of them, ascending `hn` — and a successful return marks them received. A failure
 * schedules the `repush` timer for that attempt at HEADS_UP_REPUSH_MS; a closed attempt's rows
 * stop being pushed (HU5b's "until the attempt is closed").
 */
export async function deliverHeadsUps(env: Env, ctx: DurableObjectState): Promise<void> {
  const sql = sqlOf(ctx);
  const pool = ctx.id.name ?? "";
  const rows = sql
    .exec(
      `SELECT h.attempt_id AS attempt_id, h.hn AS hn, h.body AS body
       FROM heads_ups h JOIN attempts a ON a.attempt_id = h.attempt_id
       WHERE h.received_at IS NULL AND a.state NOT IN ('stopped', 'landed')
       ORDER BY h.attempt_id, h.hn`,
    )
    .toArray();
  const byAttempt = new Map<string, Array<{ hn: number; body: string }>>();
  for (const row of rows) {
    const id = String(row.attempt_id);
    const list = byAttempt.get(id) ?? [];
    list.push({ hn: Number(row.hn), body: String(row.body) });
    byAttempt.set(id, list);
  }
  for (const [attempt_id, heads] of byAttempt) {
    const heads_ups = heads.map((h) => JSON.parse(h.body) as unknown);
    let ok = false;
    try {
      const response = await env.AGENT.get(env.AGENT.idFromName(attempt_id)).fetch("https://agent/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt_id, pool, heads_ups }),
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      sql.transaction(() => {
        const now = Date.now();
        for (const h of heads)
          sql.exec(
            "UPDATE heads_ups SET received_at = ? WHERE attempt_id = ? AND hn = ? AND received_at IS NULL",
            now,
            attempt_id,
            h.hn,
          );
        sql.exec("DELETE FROM timers WHERE kind = 'repush' AND key = ?", attempt_id);
      });
    } else {
      sql.transaction(() => timerPut(sql, "repush", attempt_id, Date.now() + HEADS_UP_REPUSH_MS));
      recordTrunkError(ctx, `heads_up:${attempt_id}`, "transport");
    }
  }
}
