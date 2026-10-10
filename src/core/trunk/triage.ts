// src/core/trunk/triage.ts — the engine side of the asynchronous Clef triage (01-core 7.3, TR10):
// the `triage_asks` question store (its table is in schema.ts) written in the accept transaction, the dispatch that turns
// its unsent rows into one `TriageInput` per attempt and decider, the V7 re-ask, the TR6
// deadline and restart rules, and the rebuild of a pending item after the object reopened.
// Pure and synchronous like the rest of the engine: time is `pool.now()`, the Clef call itself
// is the Worker's (src/worker/trunk/triage-runner.ts).

import { CLEF_MAX_QUESTIONS, CLEF_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { TriageInput } from "../../protocol/ports.ts";
import { triageInputOf } from "../classify/triage.ts";
import type { Attempt, ClassifyItem, FileMap, PendingTriage, Pool } from "./sets.ts";
import { pathOf } from "./sets.ts";

type Question = TriageInput["premises"][string];

/** What a row freezes (TR10): the S6 question and the item fields V7 and the heads-up need. */
type Frozen = {
  question: Question;
  item: {
    old_hash: string;
    new_hash: string;
    members: string[] | null;
    oldMembers: string[] | null;
    after_src: string | null;
    changed: string[];
    added: string[];
    removed: string[];
    context: string[];
    rule: string;
    reason: string;
    decider: string | null;
    /** The texts of every path the item names, before and after (absent: the path did not exist). */
    before: Record<string, string>;
    after: Record<string, string>;
  };
};

type AskRow = {
  attempt_id: string;
  kind: string;
  key: string;
  decider_id: string;
  frozen: string;
  asked_op_seq: number;
  dispatched_at: number | null;
  deadline_at: number | null;
  tries: number;
};

/** One request the Worker sends through the `Triage` port, and the stamps its answers return with. */
export type TriageRequest = {
  attempt_id: string;
  decider_id: string;
  input: TriageInput;
  /** Question id (`<kind>:<key>`) -> the premise and the `asked_op_seq` it was sent with (V7). */
  asked: Record<string, { kind: string; key: string; asked_op_seq: number }>;
};

/** The unavailable outcomes the engine decides itself; the answer call closes them (TR3). */
export type TriageClose = { attempt: string; kind: string; key: string; error: string };

const qid = (kind: string, key: string): string => `${kind}:${key}`;

function rowsOf(pool: Pool, where: string, ...bindings: Array<string | number>): AskRow[] {
  return pool.sql
    .exec(`SELECT * FROM triage_asks ${where}`, ...bindings)
    .toArray()
    .map((r) => ({
      attempt_id: String(r.attempt_id),
      kind: String(r.kind),
      key: String(r.key),
      decider_id: String(r.decider_id),
      frozen: String(r.frozen),
      asked_op_seq: Number(r.asked_op_seq),
      dispatched_at: r.dispatched_at === null ? null : Number(r.dispatched_at),
      deadline_at: r.deadline_at === null ? null : Number(r.deadline_at),
      tries: Number(r.tries),
    }));
}

/** The paths whose texts an item needs: its own, and those of the keys it lists. */
function pathsOf(it: ClassifyItem): string[] {
  const keys = [it.key, ...(it.added ?? []), ...(it.context ?? []), ...(it.changed ?? [])];
  const paths = new Set<string>();
  for (const k of keys) {
    if (k.startsWith("text:") || k.startsWith("refs:") || k.startsWith("outline:")) continue;
    paths.add(pathOf(k.split("*")[0] ?? k));
  }
  if (it.kind === "listing") paths.clear();
  return [...paths];
}

function textsOf(map: FileMap, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const text = map.get(path);
    if (text !== undefined) out[path] = text;
  }
  return out;
}

/** The `triage` timer (AL1, TR6): due at the earliest deadline, or `CLEF_TIMEOUT_MS` after a row
 * that is not sent yet; deleted when no row is left. */
function armTimer(pool: Pool): void {
  const row = pool.sql
    .exec("SELECT MIN(COALESCE(deadline_at, ?)) AS due, COUNT(*) AS n FROM triage_asks", pool.now() + CLEF_TIMEOUT_MS)
    .toArray()[0];
  if (row === undefined || Number(row.n) === 0) {
    pool.sql.exec("DELETE FROM timers WHERE kind = 'triage' AND key = ''");
    return;
  }
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('triage', '', ?)", Number(row.due));
}

/**
 * TR10: in the transaction that makes `t` pending, write its question row. `decider` is the
 * attempt whose intent, patch and truth list the request carries (the landed reader for QR4).
 */
export function recordAsk(pool: Pool, t: PendingTriage, decider: Attempt, causeAttempt: Attempt | null): void {
  const it = t.it;
  if (it === null) return;
  const question = triageInputOf(pool, t.a, decider, [it], causeAttempt).premises[qid(t.p.kind, t.p.key)];
  if (question === undefined) return;
  if (question.changed_by_intent === null && it.rule !== "QR4" && t.judgment.cause_seq !== null) {
    // The change that changed the key is the landing the judgment names (7.3's `changed_by_intent`).
    const seq = t.judgment.cause_seq;
    const landing = [...pool.landings, ...pool.newLandings].find((l) => l.seq === seq);
    const changer = landing?.attempt_id == null ? undefined : pool.attempts.get(landing.attempt_id);
    const text = changer === undefined ? undefined : pool.intents.get(changer.intent_id)?.text;
    if (text !== undefined) question.changed_by_intent = text;
  }
  const paths = pathsOf(it);
  const frozen: Frozen = {
    question,
    item: {
      old_hash: it.old_hash,
      new_hash: it.new_hash,
      members: it.members,
      oldMembers: it.oldMembers,
      after_src: it.after_src ?? null,
      changed: it.changed ?? [],
      added: it.added ?? [],
      removed: it.removed ?? [],
      context: it.context ?? [],
      rule: it.rule ?? "",
      reason: it.reason ?? "",
      decider: it.decider ?? null,
      before: textsOf(it.before, paths),
      after: textsOf(it.after, paths),
    },
  };
  pool.sql.exec(
    `INSERT OR REPLACE INTO triage_asks
       (attempt_id, kind, key, decider_id, frozen, asked_op_seq, dispatched_at, deadline_at, tries)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
    t.a.id,
    t.p.kind,
    t.p.key,
    decider.id,
    JSON.stringify(frozen),
    t.stamp,
  );
  armTimer(pool);
}

/** V7: the question stays triage after an operation — ask it again with the current patch. */
export function reask(pool: Pool, t: PendingTriage): void {
  t.judgment.asked_op_seq = t.stamp;
  t.judgment.dirty = true;
  pool.sql.exec(
    `UPDATE triage_asks SET asked_op_seq = ?, dispatched_at = NULL, deadline_at = NULL
     WHERE attempt_id = ? AND kind = ? AND key = ?`,
    t.stamp,
    t.a.id,
    t.p.kind,
    t.p.key,
  );
  armTimer(pool);
}

/** The question is closed (TR3, V7, V7a): its row goes. */
export function closeAsk(pool: Pool, attempt: string, kind: string, key: string): void {
  pool.sql.exec("DELETE FROM triage_asks WHERE attempt_id = ? AND kind = ? AND key = ?", attempt, kind, key);
  armTimer(pool);
}

/**
 * TR10 reopen: a pending judgment loaded without its classification item gets it back from its
 * row, and its stamp from the `asked_op_seq` it was last asked with.
 */
export function thawPending(pool: Pool): void {
  for (const t of pool.pendingTriage) {
    if (t.it !== null) continue;
    const row = rowsOf(pool, "WHERE attempt_id = ? AND kind = ? AND key = ?", t.a.id, t.p.kind, t.p.key)[0];
    if (row === undefined) continue;
    const f = JSON.parse(row.frozen) as Frozen;
    t.stamp = row.asked_op_seq;
    t.it = {
      p: t.p,
      kind: t.p.kind,
      key: t.p.key,
      old_hash: f.item.old_hash,
      new_hash: f.item.new_hash,
      members: f.item.members,
      oldMembers: f.item.oldMembers,
      before: new Map(Object.entries(f.item.before)),
      after: new Map(Object.entries(f.item.after)),
      after_src: f.item.after_src,
      changed: f.item.changed,
      added: f.item.added,
      removed: f.item.removed,
      context: f.item.context,
      rule: f.item.rule,
      result: "triage",
      reason: f.item.reason,
      ...(f.item.decider === null ? {} : { decider: f.item.decider }),
    };
  }
}

/** Rows whose judgment is no longer pending are deleted (TR10 reopen). */
function sweep(pool: Pool): void {
  const pending = new Set(pool.pendingTriage.map((t) => JSON.stringify([t.a.id, t.p.kind, t.p.key])));
  for (const row of rowsOf(pool, "")) {
    if (!pending.has(JSON.stringify([row.attempt_id, row.kind, row.key])))
      closeAsk(pool, row.attempt_id, row.kind, row.key);
  }
}

/**
 * TR10 dispatch: every unsent row is marked sent with its deadline and grouped into one request
 * per attempt and decider. Questions beyond `CLEF_MAX_QUESTIONS` in one request come back in
 * `close` as unavailable (`too_many_questions`); the caller closes them through `triage`.
 */
export function dispatch(pool: Pool): { requests: TriageRequest[]; close: TriageClose[] } {
  sweep(pool);
  const now = pool.now();
  const groups = new Map<string, AskRow[]>();
  for (const row of rowsOf(pool, "WHERE dispatched_at IS NULL ORDER BY attempt_id, kind, key")) {
    const id = JSON.stringify([row.attempt_id, row.decider_id]);
    const g = groups.get(id);
    if (g === undefined) groups.set(id, [row]);
    else g.push(row);
  }
  const requests: TriageRequest[] = [];
  const close: TriageClose[] = [];
  for (const rows of groups.values()) {
    const first = rows[0]!;
    const a = pool.attempts.get(first.attempt_id);
    const decider = pool.attempts.get(first.decider_id) ?? a;
    if (a === undefined || decider === undefined) continue;
    const base = triageInputOf(pool, a, decider, [], null);
    const premises: TriageInput["premises"] = {};
    const asked: TriageRequest["asked"] = {};
    rows.forEach((row, i) => {
      if (i >= CLEF_MAX_QUESTIONS) {
        close.push({ attempt: row.attempt_id, kind: row.kind, key: row.key, error: "too_many_questions" });
        return;
      }
      const id = qid(row.kind, row.key);
      premises[id] = (JSON.parse(row.frozen) as Frozen).question;
      asked[id] = { kind: row.kind, key: row.key, asked_op_seq: row.asked_op_seq };
      pool.sql.exec(
        "UPDATE triage_asks SET dispatched_at = ?, deadline_at = ? WHERE attempt_id = ? AND kind = ? AND key = ?",
        now,
        now + CLEF_TIMEOUT_MS,
        row.attempt_id,
        row.kind,
        row.key,
      );
    });
    if (Object.keys(premises).length > 0) {
      requests.push({ attempt_id: a.id, decider_id: decider.id, input: { ...base, premises }, asked });
    }
  }
  armTimer(pool);
  return { requests, close };
}

/** TR6: a sent row still pending past its deadline is unavailable (`timeout`). */
export function overdue(pool: Pool): TriageClose[] {
  sweep(pool);
  const out = rowsOf(pool, "WHERE deadline_at IS NOT NULL AND deadline_at <= ?", pool.now()).map((row) => ({
    attempt: row.attempt_id,
    kind: row.kind,
    key: row.key,
    error: "timeout",
  }));
  armTimer(pool);
  return out;
}

/**
 * TR6 on start-up: a row an earlier instance sent has no request in flight. It is asked again
 * once (`tries = 1`); a row already asked again is unavailable (`timeout`).
 */
export function restartAsks(pool: Pool): TriageClose[] {
  sweep(pool);
  const out: TriageClose[] = [];
  for (const row of rowsOf(pool, "WHERE dispatched_at IS NOT NULL")) {
    if (row.tries >= 1) {
      out.push({ attempt: row.attempt_id, kind: row.kind, key: row.key, error: "timeout" });
      continue;
    }
    pool.sql.exec(
      `UPDATE triage_asks SET tries = 1, dispatched_at = NULL, deadline_at = NULL
       WHERE attempt_id = ? AND kind = ? AND key = ?`,
      row.attempt_id,
      row.kind,
      row.key,
    );
    const t = pool.pendingTriage.find((x) => x.a.id === row.attempt_id && x.p.kind === row.kind && x.p.key === row.key);
    if (t !== undefined) {
      t.judgment.tries = 1;
      t.judgment.dirty = true;
    }
  }
  armTimer(pool);
  return out;
}
