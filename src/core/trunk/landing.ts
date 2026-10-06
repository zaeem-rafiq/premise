// src/core/trunk/landing.ts — section 7 (validation) and the landing machinery of 9.4/9.5:
// the decision table (rowFor), classification over a (before, after) pair, heads-up sending with
// its state effects (go-arounds, pull-backs, cards), the pending-triage list (V7), the late
// sweep check, and the write set / landing record a tick commits.
//
// Everything is pure and synchronous: the head file map is `pool.files`; a classification takes
// `before` and `after` file maps and never awaits.

import type { Operation } from "../../protocol/operations.ts";
import type { PremiseKind } from "../../protocol/premise.ts";
import type { HeadsUp, HeadsUpItem } from "../../protocol/headsup.ts";
import type { Attempt, ClassifyItem, FileMap, PendingTriage, Pool, Premise, Sets } from "./sets.ts";
import {
  curOps,
  dirOf,
  entityAt,
  entityKeysOf,
  isModule,
  keyHash,
  literalNames,
  pathOf,
  replayOps,
  setsOf,
  sourceOf,
  created,
  sweeping,
} from "./sets.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { event } from "./events.ts";
import {
  closeCard,
  frozen,
  grantRightOfWay,
  hasRightOfWay,
  inflight,
  isWaiting,
  openCard,
  parked,
  sentBack,
  setState,
  unvalidate,
} from "./intents.ts";
import { syncTriageOf, triageInputOf, triageOutcome } from "../classify/triage.ts";
import { classify, rowFor } from "../classify/table.ts";
import type { Classification, Row } from "../classify/table.ts";
import { unified } from "../diff/unified.ts";

// ---------------------------------------------------------------------------
// Heads-up construction (8.1/8.2). Each trace item keeps the vector-facing shape
// ({kind,key,rule,result,added,removed,context,after}); each stored heads-up keeps the protocol
// body (HeadsUp) as well.

/** The protocol `HeadsUpItem` plus the trace shape the vectors compare. */
export function hItem(
  pool: Pool,
  a: Attempt,
  it: ClassifyItem,
  result: "holds" | "pending" | "confirm" | "repair",
  causeSeq: number | null,
): { item: HeadsUpItem; trace: Record<string, unknown> } {
  const p = it.p;
  if (p.kind === "entity") p.shown = p.hash;
  else if (p.kind === "listing") p.shown = [...(p.members ?? [])];
  let diff: HeadsUpItem["diff"];
  const trace: Record<string, unknown> = { kind: p.kind, key: p.key, rule: it.rule, result, reason: it.reason ?? "" };
  if (p.kind === "entity") {
    diff = {
      kind: "entity",
      before: sourceOf(it.before, p.key, pool.languages),
      after: it.after_src ?? sourceOf(it.after, p.key, pool.languages),
    };
    trace.after = it.after_src ?? null;
  } else if (p.kind === "file") {
    const bc = it.before.get(p.key);
    const ac = it.after.get(p.key);
    diff = {
      kind: "file",
      before_oid: bc === undefined ? "absent" : blobId(utf8(bc)),
      after_oid: ac === undefined ? "absent" : blobId(utf8(ac)),
      unified: bc !== undefined && ac !== undefined ? unified(bc, ac) : "",
      changed_entities: it.changed ?? [],
    };
  } else if (p.kind === "listing") {
    diff = { kind: "listing", added: it.added ?? [], removed: it.removed ?? [] };
    trace.added = it.added ?? [];
    trace.removed = it.removed ?? [];
  } else if (p.key.startsWith("refs:") || p.key.startsWith("outline:")) {
    diff = {
      kind: "query",
      added: (it.added ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k, pool.languages) })),
      removed: it.removed ?? [],
      context: (it.context ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k, pool.languages) ?? "" })),
    };
    trace.added = it.added ?? [];
    trace.removed = it.removed ?? [];
    trace.context = it.context ?? [];
  } else if (p.key.startsWith("text:")) {
    diff = {
      kind: "query",
      added: (it.added ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k, pool.languages) })),
      removed: it.removed ?? [],
      context: [],
    };
    trace.added = it.added ?? [];
    trace.removed = it.removed ?? [];
  } else {
    diff = { kind: "check", check: p.key, code: it.reason ?? "" };
  }
  const item: HeadsUpItem = {
    premise: { kind: p.kind, key: p.key },
    rule: it.rule ?? "",
    result,
    reason: it.reason ?? "",
    old_hash: it.old_hash,
    new_hash: it.new_hash,
    cause_seq: causeSeq,
    diff,
    uses: [],
  };
  return { item, trace };
}

/** The worst result of a dry-run classification (used by right-of-way and blast radius). */
export function worst(c: Classification): "repair" | "confirm" | "triage" | null {
  if (c.failed.length > 0 || c.items.some((i) => i.result === "repair")) return "repair";
  if (c.items.some((i) => i.result === "confirm" && i.folded !== true)) return "confirm";
  if (c.items.some((i) => i.result === "triage")) return "triage";
  return null;
}

/** OP6: drop the attempt's ops on each failed path, re-synchronize premises (R5/D1/D2). */
export function dropFailed(
  pool: Pool,
  a: Attempt,
  failed: Array<{ op_seq: number; path: string; rule: string }>,
): Array<{ op_seq: number; rule: string }> {
  const dropped: Array<{ op_seq: number; rule: string }> = [];
  for (const f of failed) {
    const seqs: number[] = [];
    for (const o of a.ops) {
      if (!o.dropped && o.path === f.path) {
        o.dropped = true;
        dropped.push({ op_seq: o.op_seq, rule: f.rule });
        seqs.push(o.op_seq);
      }
    }
    if (seqs.length > 0) event(pool, "op.dropped", { attempt_id: a.id, op_seqs: seqs, path: f.path, rule: f.rule });
  }
  if (dropped.length > 0) {
    const { syncPremises } = require_sync();
    syncPremises(pool, a);
    pool.dirtyAttempts.add(a.id);
  }
  return dropped;
}

// The import of premises.ts is deferred behind a function to keep the module graph acyclic:
// premises.ts never imports landing.ts.
import { syncPremises as syncPremisesImpl } from "./premises.ts";
function require_sync(): { syncPremises: typeof syncPremisesImpl } {
  return { syncPremises: syncPremisesImpl };
}

export type HeadsUpCause = {
  type: "landing" | "submit" | "undo" | "revert";
  seqs: number[];
  changes: Array<{ seq: number; change_id: string; intent_text: string | null }>;
};

/**
 * Send a heads-up (8.1): stored on the attempt, traced for the driver, `headsup.sent` emitted,
 * then the state effects — a repair starts or joins a go-around; a confirm to a waiting attempt
 * is a pull-back (T11).
 */
/** Push a heads-up onto the attempt and the trace; no state change (T19's undo heads-up). */
export function pushHeadsUp(
  pool: Pool,
  a: Attempt,
  result: "info" | "confirm" | "repair",
  items: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }>,
  dropped: Array<{ op_seq: number; rule: string }>,
  cause: HeadsUpCause,
): {
  hn: number;
  result: "info" | "confirm" | "repair";
  body: HeadsUp;
  received_at: number | null;
  delivered_at: number | null;
  resolved_at: number | null;
} {
  const hn = a.next_hn;
  a.next_hn += 1;
  const wake = result !== "info" && a.state !== "stopped";
  const body: HeadsUp = {
    hn,
    attempt_id: a.id,
    result,
    wake,
    cause: { type: cause.type, seqs: cause.seqs, changes: cause.changes },
    items: items.map((x) => x.item),
    dropped_ops: dropped.map((d) => {
      const op = a.ops.find((o) => o.op_seq === d.op_seq);
      return { op_seq: d.op_seq, path: op?.path ?? "", rule: d.rule as "OP1" | "OP2" | "OP3" | "OP4" | "OP5" };
    }),
    go_around: null,
    head_seq: pool.headSeq(),
    created_at: pool.now(),
  };
  const h = {
    hn,
    result,
    wake,
    body,
    created_at: pool.now(),
    received_at: null,
    delivered_at: null,
    resolved_at: result === "info" ? pool.now() : null,
    statement: null,
    op_mark: a.opCount,
  };
  a.heads.push(h);
  // PM2: the first `confirm`/`repair` heads-up of a revision freezes `ops_first` — the
  // operations the attempt held at this moment, with this heads-up's OP6 drops still held —
  // and whether a submit had already passed (`submitted`, `validated` or `held`, PM4).
  if ((result === "confirm" || result === "repair") && !a.opsFirstDone) {
    const undrop = new Set(dropped.map((d) => d.op_seq));
    pool.sql.exec(
      "INSERT OR REPLACE INTO ops_first (attempt_id, revision, ops, submitted) VALUES (?, ?, ?, ?)",
      a.id,
      a.revision,
      JSON.stringify(a.ops.map((o) => (undrop.has(o.op_seq) ? { ...o, dropped: false } : o))),
      a.submitted_at === null ? 0 : 1,
    );
    a.opsFirstDone = true;
  }
  pool.dirtyAttempts.add(a.id);
  pool.out.heads_ups.push({
    to: a.id,
    hn,
    result,
    cause: cause.type,
    wake,
    items: items.map((x) => x.trace),
    dropped_ops: dropped,
  });
  return h;
}

/** `headsup.sent` (12.1): emitted once per heads-up, with the body's final `go_around`. */
export function emitSent(
  pool: Pool,
  a: Attempt,
  h: { hn: number; body: HeadsUp },
  items: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }>,
): void {
  event(pool, "headsup.sent", {
    attempt_id: a.id,
    hn: h.hn,
    result: h.body.result,
    wake: h.body.wake,
    cause: h.body.cause,
    keys: items.map((x) => ({ kind: x.item.premise.kind, key: x.item.premise.key, rule: x.item.rule })),
    items: h.body.items,
    dropped_ops: h.body.dropped_ops,
    go_around: h.body.go_around,
  });
}

export function sendHeadsUp(
  pool: Pool,
  a: Attempt,
  result: "info" | "confirm" | "repair",
  items: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }>,
  dropped: Array<{ op_seq: number; rule: string }>,
  cause: HeadsUpCause,
  e1keys: string[] = [],
  causeAttempt: Attempt | null = null,
): void {
  const h = pushHeadsUp(pool, a, result, items, dropped, cause);
  const sent = (): void => {
    if (h.body.go_around === null) h.body.go_around = a.go_arounds;
    emitSent(pool, a, h, items);
  };
  if (result === "repair") {
    enterRepair(pool, a, h, e1keys, causeAttempt, sent);
  } else {
    emitSent(pool, a, h, items);
    if (result === "confirm" && isWaiting(a)) {
      // T11: a confirm heads-up to a queued attempt pulls it back.
      closeCard(pool, a, "stale");
      if (sentBack(a) >= pool.K.GO_AROUND_LIMIT) {
        setState(pool, a, "stopped", "T11s", "go_around_limit");
        openCard(pool, "choice", "go_around_limit", [a.id]);
        return;
      }
      a.pull_backs += 1;
      if (sentBack(a) === pool.K.STARVATION_AFTER) grantRightOfWay(pool, a);
      setState(pool, a, "needs_confirm", "T11");
      unvalidate(pool, a);
    }
  }
}

/** The repair state effect (9.2): go-around counting, GA1 join, contradiction, the limit. */
export function enterRepair(
  pool: Pool,
  a: Attempt,
  h: { hn: number },
  e1keys: string[],
  causeAttempt: Attempt | null,
  sent: () => void,
): void {
  if (a.state === "stopped") {
    sent();
    for (const k of e1keys) a.e1.add(k);
    return;
  }
  if (a.state === "going_around") {
    const earlier = a.heads.filter((x) => x.hn !== h.hn && x.result === "repair" && x.resolved_at === null);
    if (earlier.some((x) => x.delivered_at === null)) {
      // T10 joins this go-around without incrementing; ST1 still emits the transition.
      sent();
      event(pool, "attempt.state", {
        attempt_id: a.id,
        from: "going_around",
        to: "going_around",
        transition: "T10",
        reason: null,
        go_arounds: a.go_arounds,
        pull_backs: a.pull_backs,
        right_of_way: a.right_of_way_at !== null,
      });
      for (const k of e1keys) a.e1.add(k);
      return; // GA1: joins this go-around only when every earlier repair heads-up was delivered
    }
  }
  const contradiction =
    e1keys.some((k) => a.e1.has(k)) && causeAttempt !== null && causeAttempt.intent_id !== a.intent_id;
  for (const k of e1keys) a.e1.add(k);
  closeCard(pool, a, "stale");
  if (contradiction) {
    sent();
    setState(pool, a, "stopped", "T9c", "contradiction");
    openCard(pool, "choice", "contradiction", [a.id, causeAttempt.id]);
    return;
  }
  if (sentBack(a) >= pool.K.GO_AROUND_LIMIT) {
    sent();
    setState(pool, a, "stopped", "T9", "go_around_limit");
    openCard(pool, "choice", "go_around_limit", [a.id]);
    return;
  }
  a.go_arounds += 1;
  a.op_mark = a.opCount; // HU12: where this go-around started
  if (sentBack(a) === pool.K.STARVATION_AFTER) grantRightOfWay(pool, a);
  sent();
  if (a.state !== "going_around") setState(pool, a, "going_around", "T8");
  else
    event(pool, "attempt.state", {
      attempt_id: a.id,
      from: "going_around",
      to: "going_around",
      transition: "T10a",
      reason: null,
      go_arounds: a.go_arounds,
      pull_backs: a.pull_backs,
      right_of_way: a.right_of_way_at !== null,
    });
  unvalidate(pool, a);
  pool.dirtyAttempts.add(a.id);
}

/** Apply a classification to an in-flight or parked attempt (judgments, statuses, the heads-up). */
export function applyClassification(
  pool: Pool,
  a: Attempt,
  c: Classification,
  after: FileMap,
  seq: number,
  cause: HeadsUpCause,
  causeAttempt: Attempt | null,
): void {
  const hItems: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }> = [];
  let strongest: "info" | "confirm" | "repair" | null = null;
  const e1keys: string[] = [];
  // S6a/TR5: when the attempt's triage is a `SyncTriage` the rows are decided inside this
  // transaction — the pool's port (`ScriptedTriage`) for a synthetic attempt, `OffTriage`
  // while CLEF_TRIAGE is off or the kill switch is set — one `judgeNow` per deciding attempt
  // (QR4's decider is the landed change, not the receiver). Otherwise the premises wait on
  // the asynchronous Clef `Triage` of TR2.
  const deciderOf = (it: ClassifyItem): Attempt => {
    if (it.rule !== "QR4") return a;
    // TR8/SW5: for QR4 the landed change that read the key decides. The classifier names it;
    // the batch's E1 cause is the fallback for a landing that came without one.
    const reader = it.decider === undefined ? undefined : pool.attempts.get(it.decider);
    return reader ?? causeAttempt ?? a;
  };
  const syncOut = new Map<Attempt, { answers: Record<string, number | null>; model: string }>();
  const syncT = syncTriageOf(pool, a);
  if (syncT !== null) {
    const groups = new Map<Attempt, ClassifyItem[]>();
    for (const it of c.items) {
      if ((it.result ?? "holds") !== "triage" || it.folded === true) continue;
      const decider = deciderOf(it);
      const g = groups.get(decider);
      if (g === undefined) groups.set(decider, [it]);
      else g.push(it);
    }
    for (const [decider, items] of groups)
      syncOut.set(decider, syncT.judgeNow(triageInputOf(pool, a, decider, items, causeAttempt)));
  }
  for (const it of c.items) {
    const p = it.p;
    const rowResult = it.result ?? "holds";
    if (rowResult === "delete") {
      a.premises.delete(`${p.kind}|${p.key}`);
      event(pool, "premise.removed", { attempt_id: a.id, kind: p.kind, key: p.key, rule: it.rule });
      pool.dropPendingItem(a, p);
      continue;
    }
    const cur = keyHash(after, p.kind, p.key, pool.languages);
    p.hash = cur.hash;
    p.seq = seq;
    p.members = cur.members;
    const syncAnswer =
      rowResult === "triage" && it.folded !== true && syncOut.has(deciderOf(it))
        ? (syncOut.get(deciderOf(it))?.answers[`${p.kind}:${p.key}`] ?? null)
        : undefined;
    const outcome =
      syncAnswer === undefined
        ? null
        : { ...triageOutcome(pool, syncAnswer), model: syncOut.get(deciderOf(it))!.model };
    const j = pool.newJudgment(a, {
      kind: p.kind,
      key: p.key,
      old_hash: it.old_hash,
      new_hash: it.new_hash,
      cause: cause.type,
      cause_seq: firstCauseSeq(cause),
      rule: it.rule ?? "",
      klass: rowResult === "triage" ? "triage" : "rule",
      result:
        outcome !== null ? outcome.result : rowResult === "triage" ? null : rowResult === "info" ? "holds" : rowResult,
      reason: outcome?.reason ?? it.reason ?? "",
      heads_up: it.folded !== true && rowResult !== "holds",
      ...(outcome !== null ? { clef: { model: outcome.model, p: syncAnswer ?? null, error: null } } : {}),
    });
    if (outcome !== null) {
      j.t_repair = pool.K.T_REPAIR;
      j.t_confirm = pool.K.T_CONFIRM;
      it.reason = outcome.reason;
    }
    pool.out.judgments.push(j);
    if (it.folded === true) {
      p.status = "holds";
      continue;
    }
    if (rowResult === "triage") {
      if (outcome !== null) {
        // TR5: a synchronous decider answered inside this transaction — no pending item and
        // no triage timer; the item is in the batch's heads-up with its final result (an
        // info-level item for `holds`, so a re-affirmation is never silent).
        p.status =
          outcome.result === "repair" ? "pending_repair" : outcome.result === "confirm" ? "pending_confirm" : "holds";
        hItems.push(hItem(pool, a, it, outcome.result, j.cause_seq));
        if (outcome.result === "repair") {
          strongest = "repair";
          if (it.rule === "E1") e1keys.push(p.key);
        } else if (outcome.result === "confirm") {
          if (strongest !== "repair") strongest = "confirm";
        } else if (strongest === null) strongest = "info";
        continue;
      }
      p.status = "pending_triage";
      j.asked_op_seq = a.opCount;
      const t: PendingTriage = { a, p, judgment: j, it, cause: cause.type, stamp: a.opCount };
      pool.pendingTriage.push(t);
      a.pending.push(j);
      hItems.push(hItem(pool, a, it, "pending", j.cause_seq));
      if (strongest === null) strongest = "info";
      continue;
    }
    if (rowResult === "repair") {
      p.status = "pending_repair";
      strongest = "repair";
      if (it.rule === "E1") e1keys.push(p.key);
    } else if (rowResult === "confirm") {
      p.status = "pending_confirm";
      if (strongest !== "repair") strongest = "confirm";
    } else if (rowResult === "info" && strongest === null) {
      strongest = "info";
    }
    if (rowResult !== "holds") hItems.push(hItem(pool, a, it, rowResult === "info" ? "holds" : rowResult, j.cause_seq));
  }
  const dropped = dropFailed(pool, a, c.failed);
  if (dropped.length > 0) strongest = "repair";
  if (strongest === null) {
    pool.dirtyAttempts.add(a.id);
    return;
  }
  sendHeadsUp(pool, a, strongest, hItems, dropped, cause, e1keys, causeAttempt);
}

function firstCauseSeq(cause: HeadsUpCause): number | null {
  return cause.seqs.length === 0 ? null : (cause.seqs[0] ?? null);
}

/** V7: a pending triage is evaluated again after every operation, on the frozen maps. */
export function reevaluate(pool: Pool, a: Attempt): void {
  const s = setsOf(a, pool.files, pool.languages);
  const items: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }> = [];
  let strongest: "confirm" | "repair" | null = null;
  const e1keys: string[] = [];
  for (const t of pool.pendingTriage.filter((x) => x.a === a)) {
    if (t.it === null) continue; // a pending row rebuilt after a restart cannot be re-rowed (TR6)
    const row: Row =
      t.it.rule === "QR4" ? ["QR4", "triage", "reader_landed"] : rowFor(pool, a, t.p, t.it, s, t.it.before, t.it.after);
    if (row[1] === "triage") {
      t.stamp = a.opCount;
      pool.out.reasked.push({ attempt: a.id, kind: t.p.kind, key: t.p.key });
      continue;
    }
    if (row[1] !== "repair" && row[1] !== "confirm") {
      t.stamp = a.opCount;
      continue;
    }
    pool.pendingTriage.splice(pool.pendingTriage.indexOf(t), 1);
    t.it.rule = row[0];
    t.it.result = row[1];
    t.judgment.result = row[1];
    t.judgment.rule = row[0];
    t.judgment.klass = "rule";
    t.judgment.resolved_at = pool.now();
    t.judgment.dirty = true;
    pool.out.judgments.push(t.judgment);
    event(pool, "premise.judged", {
      attempt_id: a.id,
      kind: t.p.kind,
      key: t.p.key,
      old_hash: t.judgment.old_hash,
      new_hash: t.judgment.new_hash,
      cause: t.judgment.cause,
      cause_seq: t.judgment.cause_seq,
      rule: row[0],
      class: "rule",
      result: row[1],
      reason: row[2],
      clef: null,
    });
    t.p.status = row[1] === "repair" ? "pending_repair" : "pending_confirm";
    if (row[1] === "repair") {
      strongest = "repair";
      if (row[0] === "E1") e1keys.push(t.p.key);
    } else if (strongest === null) strongest = "confirm";
    items.push(hItem(pool, a, t.it, row[1], t.judgment.cause_seq));
  }
  if (strongest !== null) {
    sendHeadsUp(pool, a, strongest, items, [], { type: "landing", seqs: [], changes: [] }, e1keys, null);
  }
}

/** The late L1 check (4.7 W5): a sweep whose directory gained names it was never shown. */
export function lateSweep(pool: Pool, a: Attempt): void {
  const head = pool.files;
  const items: Array<{ item: HeadsUpItem; trace: Record<string, unknown> }> = [];
  for (const p of a.premises.values()) {
    if (p.kind !== "listing" || p.status !== "holds") continue;
    const made = created(a, head);
    const prefix = p.key === "/" ? "" : p.key;
    const shown = Array.isArray(p.shown) ? p.shown : [];
    const unshown = (p.members ?? []).filter((n) => !shown.includes(n) && !made.has(prefix + n));
    if (unshown.length === 0 || !sweeping(a, p.key, head)) continue;
    const j = pool.newJudgment(a, {
      kind: p.kind,
      key: p.key,
      old_hash: p.hash,
      new_hash: p.hash,
      cause: "landing",
      cause_seq: null,
      rule: "L1",
      klass: "rule",
      result: "repair",
      reason: "sweep_incomplete",
    });
    pool.out.judgments.push(j);
    p.status = "pending_repair";
    p.shown = [...(p.members ?? [])];
    const it: ClassifyItem = {
      p,
      kind: p.kind,
      key: p.key,
      old_hash: p.hash,
      new_hash: p.hash,
      members: p.members,
      oldMembers: p.members,
      before: head,
      after: head,
      added: unshown,
      removed: [],
      rule: "L1",
      result: "repair",
      reason: "sweep_incomplete",
    };
    items.push(hItem(pool, a, it, "repair", null));
  }
  if (items.length > 0) sendHeadsUp(pool, a, "repair", items, [], { type: "landing", seqs: [], changes: [] });
}

/** W5/R5: after a recorded operation — T22, sync, re-evaluate pending triage, late sweep. */
export function afterOp(pool: Pool, a: Attempt, op: Operation, pre: FileMap): Premise[] {
  if (isWaiting(a)) {
    closeCard(pool, a, "stale");
    unvalidate(pool, a);
    a.tier = null;
    setState(pool, a, "working", "T22");
  }
  const premises = syncPremisesImpl(pool, a);
  // op.recorded (12.1): `targets` is a replace's touched keys, else the path's post-op keys;
  // `added`/`removed` are the op's own delta on the attempt view; `altered` is a key that was at
  // head and whose content this op changed.
  const head = pool.files;
  const post = replayOps(curOps(a), head, {}, pool.languages).files;
  const keysOf = (m: FileMap): string[] =>
    entityKeysOf(m, op.path, pool.languages) ?? (m.has(op.path) ? [op.path] : []);
  const preKeys = keysOf(pre);
  const postKeys = keysOf(post);
  const preSet = new Set(preKeys);
  const postSet = new Set(postKeys);
  const atHead = (k: string): boolean => (k.includes("#") ? entityAt(head, k, pool.languages) !== null : head.has(k));
  const hashOf = (m: FileMap, k: string): string =>
    k.includes("#") ? (entityAt(m, k, pool.languages)?.hash ?? "") : blobId(utf8(m.get(k) ?? ""));
  event(pool, "op.recorded", {
    attempt_id: a.id,
    op_seq: op.op_seq,
    op: op.op,
    path: op.path,
    targets: op.op === "replace" ? op.targets : postKeys,
    altered: postKeys.filter((k) => preSet.has(k) && atHead(k) && hashOf(pre, k) !== hashOf(post, k)),
    added: postKeys.filter((k) => !preSet.has(k)),
    removed: preKeys.filter((k) => !postSet.has(k)),
  });
  reevaluate(pool, a);
  lateSweep(pool, a);
  return premises;
}

/** The blast radius of a held submit (10.3): who would break, confirm or triage if it landed. */
export function blast(
  pool: Pool,
  a: Attempt,
  head = pool.files,
  excluded: ReadonlySet<Attempt> = new Set(),
): { repair: string[]; confirm: string[]; triage: string[]; right_of_way: string[] } {
  const after = replayOps(curOps(a), head, {}, pool.languages).files;
  const out = { repair: [] as string[], confirm: [] as string[], triage: [] as string[], right_of_way: [] as string[] };
  for (const o of inflight(pool)) {
    if (o === a || excluded.has(o)) continue;
    const res = worst(classify(pool, o, head, after, null, [frozen(a)]));
    if (res !== null) out[res].push(o.id);
  }
  // 10.2 step 4: the entries that hold right of way — `land_now` joins the card's options
  // while one of them sits under `repair` or `confirm`.
  out.right_of_way = [...out.repair, ...out.confirm, ...out.triage].filter((id) => {
    const x = pool.attempts.get(id);
    return x !== undefined && hasRightOfWay(pool, x);
  });
  return out;
}
