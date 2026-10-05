// src/core/rebuild/apply.ts — the engine half of "rebuild from Artifacts" (01-core.md 3.6).
// Synchronous and transaction-bound like every engine step: the owner's `rebuild` entry calls
// `armRebuild`, the worker job's per-run commits call `beginRebuild` and `applyRebuildStep`, and
// the register-deadline timer calls `registerDeadline`. No remote read happens here — the job
// feeds `ApplyPayload`s in (SY2, AL4).

import { REGISTER_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { Landing, Pool } from "../trunk/sets.ts";
import { an } from "../trunk/sets.ts";
import { emitPoolFiles, emitPoolState, event, metaWrite } from "../trunk/events.ts";
import { metaSet } from "../trunk/schema.ts";
import { utf8 } from "../sync/bytes.ts";
import { attemptFromRow } from "../trunk/registry.ts";
import type { ApplyPayload, ExpectedRegister, LandingPlan, RebuildCursor } from "./plan.ts";

export const CURSOR_KEY = "rebuild_cursor";

export function rebuildCursorOf(pool: Pool): RebuildCursor | null {
  const raw = pool.meta.get(CURSOR_KEY);
  if (raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw) as RebuildCursor;
  } catch {
    return null;
  }
}

/** The tables a rebuild re-derives from Artifacts — `meta`, `timers` handled separately. */
const WIPE_TABLES = [
  "files",
  "trees",
  "entities",
  "refs",
  "intents",
  "attempts",
  "premises",
  "ops",
  "ops_first",
  "heads_ups",
  "judgments",
  "landings",
  "landing_files",
  "landing_writes",
  "landing_premises",
  "landing_ops",
  "blobs",
  "outbox",
  "outbox_chunks",
  "cards",
  "undo_requests",
  "events_out",
] as const;

/** The transient `meta` prefixes a rebuild drops (per-attempt caches, timer failure counts,
 * the plain pool's in-flight build — `plain_commit`/`plain_through_seq`/`plain_remote` stay:
 * they name what the remote still holds, and the finish's `plain` arm verifies it). */
const TRANSIENT_META = [
  "steps:",
  "checks:",
  "approved:",
  "timer_fails:",
  "events_tries",
  "register_expect",
  "plain_pending",
  "plain_tries",
];

/** `meta` has no tombstones: the row and the in-memory copy go together. */
function metaDelete(pool: Pool, key: string): void {
  pool.meta.delete(key);
  metaSet(pool.sql, key, null);
}

/**
 * The `rebuild` engine entry (13.6): parks a durable cursor at stage `await` and arms the
 * `rebuild` timer — the wipe itself waits for the job's first run, which resolves the new `epoch`
 * from the Floor first (RB5: before the rebuilt pool emits anything). A second call while a
 * cursor stands answers `already` (9.8: the request it repeats is the one that started the job);
 * so does a call that repeats a finished request_id.
 */
export function armRebuild(pool: Pool, requestId: string): Record<string, unknown> {
  const existing = rebuildCursorOf(pool);
  if (existing !== null) return { ok: true, already: true, request_id: existing.request_id };
  if (pool.meta.get("rebuild_done") === requestId) {
    return { ok: true, already: true, request_id: requestId };
  }
  const cursor: RebuildCursor = { v: 1, request_id: requestId, stage: "await", done: 0, total: 0 };
  metaWrite(pool, CURSOR_KEY, JSON.stringify(cursor));
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild', '', ?)", pool.now());
  return { ok: true, started: true };
}

/**
 * The job's first commit: the wipe. `epoch` is the Floor's last epoch for the pool plus one
 * (resolved before the call — no remote read runs inside this transaction, SY2/AL4); `remote`
 * and `head_commit`/`notes_commit`/`green_commit` come from the same run's ref read. Every
 * non-terminal attempt is captured into `register_expect` for step 6 before its row goes.
 */
export function beginRebuild(
  pool: Pool,
  begin: {
    epoch: number;
    pool_id?: string;
    remote?: string;
    head_commit: string;
    notes_commit: string | null;
    green_commit: string | null;
  },
): Record<string, unknown> {
  const cursor = rebuildCursorOf(pool);
  if (cursor === null || cursor.stage !== "await") return { ok: false, error: { code: "not_awaited" } };
  // RB1: the outbox must first reconcile to `pushed` or `diverged` — never wiped mid-flight.
  const openOutbox = pool.sql
    .exec("SELECT batch_id FROM outbox WHERE state IN ('pending', 'notes_pending') LIMIT 1")
    .toArray();
  if (openOutbox.length > 0) return { ok: false, error: { code: "busy" } };
  const sql = pool.sql;
  const expect: ExpectedRegister[] = [...pool.attempts.values()]
    .filter((a) => a.state !== "landed" && a.state !== "stopped")
    .map((a) => ({
      attempt_id: a.id,
      intent_id: a.intent_id,
      change_id: a.change_id,
      revision: a.revision,
      state: a.state,
      agent_kind: a.agent_kind,
      model: a.model,
      intent_text: a.intentText,
      requester: a.requester,
      opened_seq: a.opened_seq,
    }));

  for (const table of WIPE_TABLES) sql.exec(`DELETE FROM ${table}`);
  for (const key of [...pool.meta.keys()]) {
    if (TRANSIENT_META.some((p) => key === p || key.startsWith(p))) metaDelete(pool, key);
  }
  pool.files = new Map();
  pool.modes = new Map();
  pool.attempts = new Map();
  pool.intents = new Map();
  pool.landings = [];
  pool.cards = [];
  pool.outbox = null;
  pool.outboxPack = null;
  pool.undoQueue = [];
  pool.undoLog = new Map();
  pool.judgments = new Map();
  pool.pendingTriage = [];
  pool.steps = new Map();
  pool.objects = new Map();
  pool.analyses = new Map();
  pool.dirtyAttempts = new Set();
  pool.dirtyCards = new Set();
  pool.dirtyIntents = new Set();
  pool.dirtyUndo = new Set();
  pool.newLandings = [];
  pool.filesChanged = new Set();
  pool.entitiesChanged = new Set();
  pool.judgmentsCounter = 0;
  pool.cardCounter = 1;
  pool.attemptCounter = 1;
  pool.undoCounter = 1;
  pool.dirtyOutbox = false;
  pool.eventBuffer = null;

  // RB5: the new epoch and a stream that restarts at source_n 1.
  pool.eventCounter = 1;
  metaWrite(pool, "pool_id", begin.pool_id ?? pool.meta.get("pool_id") ?? "");
  metaWrite(pool, "epoch", Math.max(begin.epoch, Number(pool.meta.get("epoch") ?? "0") + 1));
  metaWrite(pool, "next_event_n", 1);
  metaWrite(pool, "pool_state", "rebuilding");
  metaDelete(pool, "pause_reason");
  metaDelete(pool, "unwitnessed");
  if (begin.remote !== undefined) metaWrite(pool, "remote", begin.remote);
  const next: RebuildCursor = {
    ...cursor,
    stage: "walk",
    head_commit: begin.head_commit,
    notes_commit: begin.notes_commit,
    green_commit: begin.green_commit ?? "",
    offset: 0,
    expect,
  };
  metaWrite(pool, CURSOR_KEY, JSON.stringify(next));
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild', '', ?)", pool.now());
  emitPoolState(pool); // the epoch's first event: state `rebuilding`, rebuild {done,total}
  return { ok: true, cursor: next };
}

/** One landing's rows — landings, companions, intent, attempt — and its in-memory record. */
function applyLandingPlan(pool: Pool, plan: LandingPlan): void {
  const sql = pool.sql;
  const l = plan.landing;
  sql.exec(
    `INSERT OR REPLACE INTO landings (
      seq, kind, change_id, attempt_id, intent_id, batch_id, commit_oid, parent_oid, tree_oid,
      note_oid, note, submitted_at, accepted_at, pushed_at, undone_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    l.seq,
    l.kind,
    l.change_id,
    l.attempt_id,
    l.intent_id,
    l.batch_id,
    l.commit_oid,
    l.parent_oid,
    l.tree_oid,
    l.note_oid,
    l.note,
    l.submitted_at,
    l.accepted_at,
    l.pushed_at,
    l.undone_by,
  );
  sql.exec("DELETE FROM landing_files WHERE seq = ?", l.seq);
  for (const f of plan.files) {
    sql.exec(
      "INSERT INTO landing_files (seq, path, old_oid, new_oid) VALUES (?, ?, ?, ?)",
      l.seq,
      f.path,
      f.old_oid,
      f.new_oid,
    );
  }
  if (plan.writes !== null) {
    sql.exec("DELETE FROM landing_writes WHERE seq = ?", l.seq);
    for (const w of plan.writes) {
      sql.exec(
        "INSERT INTO landing_writes (seq, kind, key, old_hash, new_hash) VALUES (?, ?, ?, ?, ?)",
        l.seq,
        w.kind,
        w.key,
        w.old_hash,
        w.new_hash,
      );
    }
  }
  if (plan.premises !== null) {
    sql.exec("DELETE FROM landing_premises WHERE seq = ?", l.seq);
    for (const p of plan.premises) {
      sql.exec(
        "INSERT INTO landing_premises (seq, kind, key, hash, pin_seq, read, edit, derived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        l.seq,
        p.kind,
        p.key,
        p.hash,
        p.seq,
        p.read ? 1 : 0,
        p.edit ? 1 : 0,
        p.derived ? 1 : 0,
      );
    }
  }
  if (plan.ops !== null) {
    sql.exec("DELETE FROM landing_ops WHERE seq = ?", l.seq);
    for (const [i, body] of plan.ops.entries()) {
      sql.exec("INSERT INTO landing_ops (seq, op_seq, body) VALUES (?, ?, ?)", l.seq, i + 1, body);
    }
  }
  if (plan.intent !== null) {
    const i = plan.intent;
    const state = l.undone_by === null ? "landed" : "undone";
    sql.exec(
      "INSERT OR REPLACE INTO intents (intent_id, text, requester, race, state, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      i.intent_id,
      i.text,
      i.requester,
      state,
      i.created_at,
    );
    pool.intents.set(i.intent_id, {
      intent_id: i.intent_id,
      text: i.text,
      requester: i.requester,
      race: false,
      state,
      created_at: i.created_at,
    });
  }
  if (plan.attempt !== null) {
    const a = plan.attempt;
    const stopped = l.undone_by !== null;
    sql.exec(
      `INSERT OR REPLACE INTO attempts (
        attempt_id, intent_id, change_id, agent_kind, model, race, truth, resumes, state, stop_reason,
        go_arounds, pull_backs, revision, right_of_way_at, opened_seq, submit_id, summary, tier,
        approved_by, bypass_row, sets, submitted_at, validated_at, landed_seq, attempt_repo,
        model_calls, tokens_in, tokens_out, last_call_id, last_response, ack, next_hn, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
      a.attempt_id,
      a.intent_id,
      a.change_id,
      a.agent_kind,
      a.model,
      stopped ? "stopped" : "landed",
      stopped ? "undone" : null,
      a.go_arounds,
      a.pull_backs,
      a.revision,
      a.opened_seq,
      a.summary,
      a.tier,
      a.approved_by,
      a.submitted_at,
      a.landed_seq,
      a.attempt_repo,
      a.model_calls,
      a.tokens_in,
      a.tokens_out,
      a.next_hn,
      pool.now(),
    );
    if (a.steps > 0) metaSet(sql, `steps:${a.attempt_id}`, a.steps);
    if (a.approved_option !== null || a.policy_risk !== null || a.approved_at !== null) {
      metaSet(
        sql,
        `approved:${a.attempt_id}`,
        JSON.stringify({ at: a.approved_at, option: a.approved_option, risk: a.policy_risk }),
      );
    }
    const row = sql.exec("SELECT * FROM attempts WHERE attempt_id = ?", a.attempt_id).toArray()[0];
    if (row !== undefined) {
      pool.attempts.set(a.attempt_id, attemptFromRow(pool, row));
      pool.attemptCounter += 1; // as openPool counts them
    }
  }
  const landing: Landing = {
    seq: l.seq,
    kind: l.kind,
    change_id: l.change_id,
    attempt_id: l.attempt_id,
    intent_id: l.intent_id,
    batch_id: l.batch_id,
    commit_oid: l.commit_oid,
    parent_oid: l.parent_oid,
    tree_oid: l.tree_oid,
    note_oid: l.note_oid,
    note: l.note,
    submitted_at: l.submitted_at,
    accepted_at: l.accepted_at,
    pushed_at: l.pushed_at,
    undone_by: l.undone_by,
    files: new Map(plan.files.map((f) => [f.path, { old_oid: f.old_oid, new_oid: f.new_oid }])),
    writes: (plan.writes ?? []).map((w) => ({
      kind: w.kind,
      key: w.key,
      old_hash: w.old_hash,
      new_hash: w.new_hash,
    })),
    premises: (plan.premises ?? []).map((p) => ({
      kind: p.kind as Landing["premises"][number]["kind"],
      key: p.key,
      hash: p.hash,
      seq: p.seq,
      members: null,
      shown: null,
      read: p.read,
      edit: p.edit,
      derived: p.derived,
      status: "holds" as const,
    })),
    ops: (plan.ops ?? []).map((body) => JSON.parse(body) as Landing["ops"][number]),
    intentText: plan.intent?.text ?? null,
    request_id: null,
    before: new Map(),
    after: new Map(),
  };
  const at = pool.landings.findIndex((x) => x.seq >= l.seq);
  if (at === -1) pool.landings.push(landing);
  else pool.landings.splice(at, 0, landing);
}

/**
 * One job run's commit (RB3): the fetched rows, the progress pair `pool.state` reports and the
 * cursor the next run resumes from. `cursor: null` marks the finishing apply — the pool's heads,
 * indexes and ready state land in the same transaction as the last rows.
 */
export function applyRebuildStep(pool: Pool, payload: ApplyPayload): Record<string, unknown> {
  const sql = pool.sql;
  if ((pool.meta.get("pool_state") ?? "ready") !== "rebuilding") {
    return { ok: false, error: { code: "not_rebuilding" } };
  }
  if (payload.pause === "note_seq_mismatch") {
    metaDelete(pool, CURSOR_KEY);
    metaWrite(pool, "pool_state", "paused");
    metaWrite(pool, "pause_reason", "note_seq_mismatch");
    event(pool, "pool.paused", { reason: "note_seq_mismatch" });
    emitPoolState(pool);
    return { ok: true, paused: "note_seq_mismatch" };
  }
  for (const plan of payload.landings ?? []) applyLandingPlan(pool, plan);
  for (const t of payload.trees ?? []) {
    sql.exec("INSERT OR REPLACE INTO trees (dir, oid) VALUES (?, ?)", t.dir, t.oid);
  }
  for (const f of payload.files ?? []) {
    sql.exec(
      "INSERT OR REPLACE INTO files (path, mode, oid, content, parse_state, changed_seq) VALUES (?, ?, ?, ?, 'opaque', 0)",
      f.path,
      f.mode,
      f.oid,
      f.content === null ? null : utf8(f.content),
    );
    pool.files.set(f.path, f.content ?? "");
    pool.modes.set(f.path, f.mode);
  }
  for (const b of payload.blobs ?? []) {
    sql.exec("INSERT OR IGNORE INTO blobs (oid, content, seq) VALUES (?, ?, ?)", b.oid, utf8(b.content), b.seq);
  }
  if (payload.cursor !== null && payload.cursor !== undefined) {
    metaWrite(pool, CURSOR_KEY, JSON.stringify(payload.cursor));
    emitPoolState(pool);
    // RB3: the next run is armed as soon as the alarm can fire.
    sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild', '', ?)", pool.now());
    return { ok: true, done: false };
  }

  // The finishing apply: heads, indexes and the ready state in the same transaction.
  const f = payload.finish;
  if (f === undefined) return { ok: false, error: { code: "invalid_args" } };
  metaWrite(pool, "head_seq", f.head_seq);
  metaWrite(pool, "head_commit", f.head_commit);
  metaWrite(pool, "head_tree", f.head_tree);
  metaWrite(pool, "notes_commit", f.notes_commit);
  metaWrite(pool, "green_seq", f.green_seq);
  metaWrite(pool, "green_commit", f.green_commit);
  metaWrite(pool, "landed_seq", f.head_seq);
  metaWrite(pool, "landed_commit", f.head_commit);
  metaWrite(pool, "next_batch_id", f.next_batch_id);
  if (f.unwitnessed.length > 0) metaWrite(pool, "unwitnessed", JSON.stringify(f.unwitnessed));
  else metaDelete(pool, "unwitnessed");
  metaWrite(pool, "register_expect", JSON.stringify(f.expect));
  metaWrite(pool, "rebuild_done", rebuildCursorOf(pool)?.request_id ?? payload.request_id ?? "");
  // The `changed_seq` of every file row: the last landing seq that touched the path (0 else).
  const fileSeq = new Map<string, number>();
  for (const l of pool.landings) {
    for (const [path] of l.files) fileSeq.set(path, l.seq);
  }
  for (const [path, seq] of fileSeq) sql.exec("UPDATE files SET changed_seq = ? WHERE path = ?", seq, path);
  // `undone_by` links the job resolved over the whole commit list (plan.applyUndoes).
  for (const u of payload.undone ?? []) {
    sql.exec("UPDATE landings SET undone_by = ? WHERE seq = ?", u.undone_by, u.seq);
    const l = pool.landings.find((x) => x.seq === u.seq);
    if (l !== undefined) l.undone_by = u.undone_by;
    const a = pool.attempts.get(l?.attempt_id ?? "");
    if (l !== undefined && l.attempt_id !== null && a === undefined) {
      const row = sql.exec("SELECT intent_id FROM attempts WHERE attempt_id = ?", l.attempt_id).toArray()[0];
      sql.exec("UPDATE attempts SET state = 'stopped', stop_reason = 'undone' WHERE attempt_id = ?", l.attempt_id);
      if (row !== undefined) {
        sql.exec("UPDATE intents SET state = 'undone' WHERE intent_id = ?", String(row.intent_id));
        const i = pool.intents.get(String(row.intent_id));
        if (i !== undefined) i.state = "undone";
      }
    } else if (l !== undefined && l.attempt_id !== null && a !== undefined) {
      a.state = "stopped";
      a.stop_reason = "undone";
      sql.exec("UPDATE attempts SET state = 'stopped', stop_reason = 'undone' WHERE attempt_id = ?", a.id);
      const i = pool.intents.get(a.intent_id);
      if (i !== undefined) {
        i.state = "undone";
        sql.exec("UPDATE intents SET state = 'undone' WHERE intent_id = ?", i.intent_id);
      }
    }
  }
  // entities + refs from the head files (step 3's parse), parse_state reconciled per file.
  const analysis = an(pool.files);
  sql.exec("DELETE FROM entities");
  sql.exec("DELETE FROM refs");
  for (const [path, info] of analysis.modules) {
    for (const e of info.entities) {
      sql.exec(
        "INSERT OR REPLACE INTO entities (key, path, name, kind, exports, arity, hash, changed_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        `${path}#${e.name}`,
        path,
        e.name,
        e.kind,
        JSON.stringify(e.exports),
        e.arity,
        e.hash,
        fileSeq.get(path) ?? 0,
      );
    }
    sql.exec("UPDATE files SET parse_state = 'module' WHERE path = ?", path);
  }
  for (const [from, tos] of analysis.refs) {
    for (const to of tos) {
      sql.exec("INSERT OR REPLACE INTO refs (from_key, to_key) VALUES (?, ?)", from, to);
    }
  }
  // before/after maps like openPool's: derived from the head map and the landings' file diffs.
  for (const l of pool.landings) {
    l.before = pool.fileMapAt(l.seq - 1);
    l.after = l.seq === pool.headSeq() ? pool.files : pool.fileMapAt(l.seq);
  }
  metaDelete(pool, CURSOR_KEY);
  metaWrite(pool, "pool_state", "ready");
  metaDelete(pool, "pause_reason");
  // Step 8's deadline: an Agent that has not re-registered by then is recorded `lost`.
  sql.exec(
    "INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild_lost', '', ?)",
    pool.now() + REGISTER_TIMEOUT_MS,
  );
  // 11.7: the rebuilt landing set re-runs the plain replay once — idle when the remote's
  // `plain_commit` already covers it, one re-anchored commit when it moved (RB3's crash gap).
  sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('plain', '', ?)", pool.now());
  emitPoolState(pool);
  emitPoolFiles(pool);
  return { ok: true, done: true };
}

/**
 * Step 8's deadline entry (`rebuild_lost` timer): every expected attempt the pool still does not
 * know is recorded `stopped` with reason `lost` (event `attempt.state`, T20), so no card and no
 * counter waits on it.
 */
export function registerDeadline(pool: Pool): void {
  const raw = pool.meta.get("register_expect");
  if (raw === undefined || raw === "") return;
  metaDelete(pool, "register_expect");
  let expect: ExpectedRegister[];
  try {
    expect = JSON.parse(raw) as ExpectedRegister[];
  } catch {
    return;
  }
  for (const e of expect) {
    if (pool.attempts.has(e.attempt_id)) continue;
    const now = pool.now();
    pool.sql.exec(
      `INSERT INTO attempts (
        attempt_id, intent_id, change_id, agent_kind, model, race, truth, resumes, state, stop_reason,
        go_arounds, pull_backs, revision, right_of_way_at, opened_seq, submit_id, summary, tier,
        approved_by, bypass_row, sets, submitted_at, validated_at, landed_seq, attempt_repo,
        model_calls, tokens_in, tokens_out, last_call_id, last_response, ack, next_hn, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, 0, 'stopped', 'lost', 0, 0, ?, NULL, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, 0, 1, ?)`,
      e.attempt_id,
      e.intent_id,
      e.change_id,
      e.agent_kind,
      e.model,
      e.revision,
      e.opened_seq,
      now,
    );
    event(pool, "attempt.state", {
      attempt_id: e.attempt_id,
      from: e.state,
      to: "stopped",
      transition: "T20",
      reason: "lost",
      go_arounds: 0,
      pull_backs: 0,
      right_of_way: false,
    });
  }
}
