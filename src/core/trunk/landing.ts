// src/core/trunk/landing.ts — section 7 (validation) and the landing machinery of 9.4/9.5:
// the decision table (rowFor), classification over a (before, after) pair, heads-up sending with
// its state effects (go-arounds, pull-backs, cards), the pending-triage list (V7), the late
// sweep check, and the write set / landing record a tick commits.
//
// Everything is pure and synchronous: the head file map is `pool.files`; a classification takes
// `before` and `after` file maps and never awaits.

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
import { closeCard, frozen, inflight, isWaiting, openCard, parked, sentBack, setState, unvalidate } from "./intents.ts";
import { syncTriageOf, triageInputOf, triageOutcome } from "../classify/triage.ts";

export type Row = [string, "holds" | "info" | "confirm" | "repair" | "triage" | "delete", string];

/** The decision-table row of section 7.2 for one changed premise. */
export function rowFor(
  pool: Pool,
  a: Attempt,
  p: Premise,
  it: ClassifyItem,
  s: Sets,
  before: FileMap,
  after: FileMap,
): Row {
  const hasOps = curOps(a).length > 0;
  let row: Row;
  if (p.kind === "entity") {
    if (p.edit || s.Edited.has(p.key)) row = ["E1", "repair", "edited_entity_changed"];
    else if (s.NewRefs.has(p.key)) row = ["E2", "repair", "referenced_entity_changed"];
    else if (s.ModuleRefs.has(p.key)) row = ["E2m", "confirm", "module_reference_changed"];
    else if (p.read || a.premises.get(`file|${pathOf(p.key)}`)?.read === true)
      row = ["E3", "triage", "read_not_referenced"];
    else row = ["E4", "delete", "reference_gone"];
  } else if (p.kind === "file") {
    const P = p.key;
    const mb = isModule(P) ? entityKeysOf(before, P) : null;
    const ma = isModule(P) ? entityKeysOf(after, P) : null;
    const writes = curOps(a).some((o) => o.path === P && (o.op === "write" || mb === null));
    if (p.edit && writes) row = ["F1", "repair", "write_base_changed"];
    else if (mb !== null && ma !== null) {
      const D = it.changed ?? [];
      if (D.length === 0) row = ["F2", "holds", "cosmetic"];
      else if (D.some((k) => s.NewRefs.has(k) || s.Edited.has(k)) || s.NewRefs.has(P)) {
        row = ["F3", "repair", s.NewRefs.has(P) ? "referenced_file_changed" : "referenced_entity_changed"];
      } else if (D.some((k) => s.ModuleRefs.has(k)) || s.ModuleRefs.has(P))
        row = ["F3m", "confirm", "module_reference_changed"];
      else if (p.read) row = ["F4", "triage", "read_not_referenced"];
      else row = ["F7", "delete", "reference_gone"];
    } else {
      const all = [...s.NewRefs, ...s.ModuleRefs];
      const referenced = all.includes(P) || all.some((k) => k.startsWith(`${P}#`));
      if (referenced) row = ["F5", "repair", "referenced_file_changed"];
      else if (p.read) row = ["F6", "triage", "read_not_referenced"];
      else row = ["F7", "delete", "reference_gone"];
    }
  } else if (p.kind === "listing") {
    const made = created(a, before);
    const prefix = p.key === "/" ? "" : p.key;
    const shown = Array.isArray(p.shown) ? p.shown : [];
    const unshown = (it.members ?? []).filter((n) => !shown.includes(n) && !made.has(prefix + n));
    const lit = literalNames(a, s);
    const named = [...(it.added ?? []), ...(it.removed ?? [])].some(
      (n) => !made.has(prefix + n) && (lit.has(n) || lit.has(n.replace(/\.[^.]*$/, ""))),
    );
    if (unshown.length > 0 && sweeping(a, p.key, before)) {
      row = ["L1", "repair", "sweep_incomplete"];
      it.added = unshown;
    } else if (named) row = ["L2", "confirm", "listing_named"];
    else row = ["L3", "holds", "listing_unused"];
  } else if (p.key.startsWith("text:")) {
    const pinned = (it.oldMembers ?? []).map((m) => m.slice(0, m.lastIndexOf("*")));
    const swept = pinned.filter((c) =>
      c.includes("#") ? s.Altered.includes(c) : curOps(a).some((o) => o.path === c),
    ).length;
    if ((it.added ?? []).length > 0 && pinned.length > 0 && swept >= Math.min(2, pinned.length)) {
      row = ["QT1", "repair", "sweep_incomplete"];
    } else if ((it.added ?? []).length > 0) row = ["QT2", "triage", "search_gained_match"];
    else row = ["QT3", "holds", "match_lost"];
  } else if (p.key.startsWith("refs:")) {
    if (!s.Altered.includes(p.key.slice(5))) row = ["QR3", "delete", "n/a"];
    else if ((it.added ?? []).length > 0) row = ["QR1", "repair", "new_reference_to_altered_entity"];
    else if ((it.context ?? []).length > 0) row = ["QR1m", "confirm", "referrer_module_changed"];
    else row = ["QR2", "holds", "match_lost"];
  } else {
    const path = p.key.slice(8);
    const oldM = it.oldMembers ?? [];
    const newM = it.members ?? [];
    const changedNames = [...oldM.filter((l) => !newM.includes(l)), ...newM.filter((l) => !oldM.includes(l))].map(
      (l) => `${path}#${l.split("|")[0] ?? ""}`,
    );
    if (changedNames.some((k) => s.NewRefs.has(k) || s.Edited.has(k)))
      row = ["QO1", "repair", "outlined_entity_changed"];
    else row = ["QO2", "holds", "outline_unused"];
  }
  if (row[1] === "triage" && !hasOps) row = ["X0", "info", "no_patch_yet"];
  return row;
}

export type Classification = {
  items: ClassifyItem[];
  failed: Array<{ op_seq: number; path: string; rule: string }>;
  sets: Sets;
};

/**
 * Classify the attempt's changed premises against (`before` -> `after`) by section 7. `landers`
 * is the frozen premise set of landings being applied (row QR4). `rep` is the replay of the
 * attempt's ops on `after`, which double-checks the ops still apply there.
 */
export function classify(
  pool: Pool,
  a: Attempt,
  before: FileMap,
  after: FileMap,
  setsOverride: Sets | null,
  landers: Array<{ premises: Premise[] }> = [],
): Classification {
  const s = setsOverride ?? setsOf(a, before);
  const items: ClassifyItem[] = [];
  for (const p of a.premises.values()) {
    const cur = keyHash(after, p.kind, p.key);
    if (cur.hash === p.hash) continue;
    const it: ClassifyItem = {
      p,
      kind: p.kind,
      key: p.key,
      old_hash: p.hash,
      new_hash: cur.hash,
      members: cur.members,
      oldMembers: p.members,
      before,
      after,
    };
    if (p.kind === "entity") {
      it.after_src = entityAt(after, p.key) !== null ? sourceOf(after, p.key) : null;
    } else if (p.kind === "file") {
      const P = p.key;
      const mb = isModule(P) ? entityKeysOf(before, P) : null;
      const ma = isModule(P) ? entityKeysOf(after, P) : null;
      it.changed = [];
      if (mb !== null && ma !== null) {
        for (const k of new Set([...mb, ...ma])) {
          const b = entityAt(before, k);
          const c = entityAt(after, k);
          if (b === null || c === null || b.hash !== c.hash) it.changed.push(k);
        }
      }
    } else if (p.kind === "listing") {
      const oldM = p.members ?? [];
      const newM = cur.members ?? [];
      it.added = newM.filter((n) => !oldM.includes(n));
      it.removed = oldM.filter((n) => !newM.includes(n));
    } else if (p.key.startsWith("text:")) {
      const cont = (m: string): string => m.slice(0, m.lastIndexOf("*"));
      const cnt = (m: string): number => Number(m.slice(m.lastIndexOf("*") + 1));
      const oldC = new Map((p.members ?? []).map((m) => [cont(m), cnt(m)]));
      const newC = new Map((cur.members ?? []).map((m) => [cont(m), cnt(m)]));
      it.added = [...newC]
        .filter(([c, n]) => n > (oldC.get(c) ?? 0))
        .map(([c]) => c)
        .sort();
      it.removed = [...oldC]
        .filter(([c, n]) => n > (newC.get(c) ?? 0))
        .map(([c]) => c)
        .sort();
    } else if (p.key.startsWith("refs:")) {
      const isRef = (m: string): boolean => m.includes("#");
      const newM = cur.members ?? [];
      const oldM = p.members ?? [];
      it.added = newM.filter((m) => isRef(m) && !oldM.includes(m));
      it.removed = oldM.filter((m) => isRef(m) && !newM.includes(m));
      // context: entities added or altered in the modules that hold a referrer now (QR1m).
      it.context = [];
      const mods = new Set(newM.filter(isRef).map(pathOf));
      for (const m of mods) {
        for (const k of entityKeysOf(after, m) ?? []) {
          const b = before.has(m) ? entityAt(before, k) : null;
          const c = entityAt(after, k);
          if ((b === null || (c !== null && b.hash !== c.hash)) && !it.added.includes(k)) it.context.push(k);
        }
      }
      it.context.sort();
    }
    const row = rowFor(pool, a, p, it, s, before, after);
    it.rule = row[0];
    it.result = row[1];
    it.reason = row[2];
    items.push(it);
  }
  // HU2a: a file item is folded when entity items of the same classification carry every relevant
  // changed entity.
  for (const it of items) {
    if (
      it.kind === "file" &&
      (it.rule === "F3" || it.rule === "F3m") &&
      !s.NewRefs.has(it.key) &&
      !s.ModuleRefs.has(it.key)
    ) {
      const rel = (it.changed ?? []).filter((k) => s.NewRefs.has(k) || s.Edited.has(k) || s.ModuleRefs.has(k));
      if (
        rel.length > 0 &&
        rel.every((k) =>
          items.some((x) => x.kind === "entity" && x.key === k && (x.result === "repair" || x.result === "confirm")),
        )
      ) {
        it.folded = true;
      }
    }
  }
  // QR4: a landing that only read K, while this attempt alters K.
  const rep = replayOps(curOps(a), after);
  for (const K of s.Altered) {
    if (entityAt(before, K) === null || rep.failed.some((f) => f.path === pathOf(K))) continue;
    const reader = landers.some((l) =>
      l.premises.some(
        (q) =>
          q.read &&
          !q.edit &&
          !q.derived &&
          ((q.kind === "entity" && q.key === K) ||
            (q.kind === "file" &&
              q.key === pathOf(K) &&
              !l.premises.some((r) => r.kind === "entity" && r.key === K && (r.edit || r.derived)))),
      ),
    );
    if (!reader) continue;
    const p = a.premises.get(`query|refs:${K}`);
    if (p === undefined) continue;
    let it = items.find((x) => x.p === p);
    if (it !== undefined && (it.result === "repair" || it.result === "confirm")) continue;
    if (it === undefined) {
      it = {
        p,
        kind: p.kind,
        key: p.key,
        old_hash: p.hash,
        new_hash: p.hash,
        members: p.members,
        oldMembers: p.members,
        added: [],
        removed: [],
        context: [],
        before,
        after,
      };
      items.push(it);
    }
    it.rule = "QR4";
    it.result = "triage";
    it.reason = "reader_landed";
  }
  return { items, failed: rep.failed, sets: s };
}

// ---------------------------------------------------------------------------
// Heads-up construction (8.1/8.2). Each trace item keeps the vector-facing shape
// ({kind,key,rule,result,added,removed,context,after}); each stored heads-up keeps the protocol
// body (HeadsUp) as well.

function unified(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // A compact unified-style diff: common prefix, changed middle, common suffix.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;
  const out: string[] = [`@@ -${lo + 1},${a.length - lo - hi} +${lo + 1},${b.length - lo - hi} @@`];
  for (const l of a.slice(Math.max(0, lo - 3), lo)) out.push(` ${l}`);
  for (const l of a.slice(lo, a.length - hi)) out.push(`-${l}`);
  for (const l of b.slice(lo, b.length - hi)) out.push(`+${l}`);
  for (const l of a.slice(a.length - hi, Math.min(a.length, a.length - hi + 3))) out.push(` ${l}`);
  return out.join("\n");
}

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
    diff = { kind: "entity", before: sourceOf(it.before, p.key), after: it.after_src ?? sourceOf(it.after, p.key) };
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
      added: (it.added ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k) })),
      removed: it.removed ?? [],
      context: (it.context ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k) ?? "" })),
    };
    trace.added = it.added ?? [];
    trace.removed = it.removed ?? [];
    trace.context = it.context ?? [];
  } else if (p.key.startsWith("text:")) {
    diff = {
      kind: "query",
      added: (it.added ?? []).map((k) => ({ key: k, source: sourceOf(it.after, k) })),
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
  event(pool, "headsup.sent", {
    attempt_id: a.id,
    hn,
    result,
    wake,
    cause: body.cause,
    keys: items.map((x) => ({ kind: x.item.premise.kind, key: x.item.premise.key, rule: x.item.rule })),
    items: body.items,
    dropped_ops: body.dropped_ops,
    go_around: null,
  });
  return h;
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
  if (result === "repair") {
    enterRepair(pool, a, h, e1keys, causeAttempt);
    h.body.go_around = a.go_arounds;
  } else if (result === "confirm" && isWaiting(a)) {
    // T11: a confirm heads-up to a queued attempt pulls it back.
    closeCard(pool, a, "stale");
    if (sentBack(a) >= pool.K.GO_AROUND_LIMIT) {
      setState(pool, a, "stopped", "T11", "go_around_limit");
      openCard(pool, "choice", "go_around_limit", [a.id]);
      return;
    }
    a.pull_backs += 1;
    if (sentBack(a) === pool.K.STARVATION_AFTER) a.right_of_way_at = ++pool.order;
    setState(pool, a, "needs_confirm", "T11");
    unvalidate(pool, a);
  }
}

/** The repair state effect (9.2): go-around counting, GA1 join, contradiction, the limit. */
export function enterRepair(
  pool: Pool,
  a: Attempt,
  h: { hn: number },
  e1keys: string[],
  causeAttempt: Attempt | null,
): void {
  if (a.state === "stopped") {
    for (const k of e1keys) a.e1.add(k);
    return;
  }
  if (a.state === "going_around") {
    const earlier = a.heads.filter((x) => x.hn !== h.hn && x.result === "repair" && x.resolved_at === null);
    if (earlier.some((x) => x.delivered_at === null)) {
      for (const k of e1keys) a.e1.add(k);
      return; // GA1: joins this go-around only when every earlier repair heads-up was delivered
    }
  }
  const contradiction =
    e1keys.some((k) => a.e1.has(k)) && causeAttempt !== null && causeAttempt.intent_id !== a.intent_id;
  for (const k of e1keys) a.e1.add(k);
  closeCard(pool, a, "stale");
  if (contradiction) {
    setState(pool, a, "stopped", "T16", "contradiction");
    openCard(pool, "choice", "contradiction", [a.id, causeAttempt.id]);
    return;
  }
  if (sentBack(a) >= pool.K.GO_AROUND_LIMIT) {
    setState(pool, a, "stopped", "T15", "go_around_limit");
    openCard(pool, "choice", "go_around_limit", [a.id]);
    return;
  }
  a.go_arounds += 1;
  a.op_mark = a.opCount; // HU12: where this go-around started
  if (sentBack(a) === pool.K.STARVATION_AFTER) a.right_of_way_at = ++pool.order;
  if (a.state !== "going_around") setState(pool, a, "going_around", "T9");
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
  const deciderOf = (it: ClassifyItem): Attempt =>
    it.rule === "QR4" && causeAttempt !== null ? causeAttempt : a;
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
    const cur = keyHash(after, p.kind, p.key);
    p.hash = cur.hash;
    p.seq = seq;
    p.members = cur.members;
    const syncAnswer =
      rowResult === "triage" && it.folded !== true && syncOut.has(deciderOf(it))
        ? (syncOut.get(deciderOf(it))?.answers[`${p.kind}:${p.key}`] ?? null)
        : undefined;
    const outcome =
      syncAnswer === undefined ? null : { ...triageOutcome(pool, syncAnswer), model: syncOut.get(deciderOf(it))!.model };
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
        outcome !== null
          ? outcome.result
          : rowResult === "triage"
            ? null
            : rowResult === "info"
              ? "holds"
              : rowResult,
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
          outcome.result === "repair"
            ? "pending_repair"
            : outcome.result === "confirm"
              ? "pending_confirm"
              : "holds";
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
  const s = setsOf(a, pool.files);
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
export function afterOp(pool: Pool, a: Attempt): Premise[] {
  if (isWaiting(a)) {
    closeCard(pool, a, "stale");
    unvalidate(pool, a);
    a.tier = null;
    setState(pool, a, "working", "T22");
  }
  const premises = syncPremisesImpl(pool, a);
  event(pool, "op.recorded", {
    attempt_id: a.id,
    op_seq: a.opCount,
    op: a.ops[a.ops.length - 1]?.op ?? "write",
    path: a.ops[a.ops.length - 1]?.path ?? "",
    targets:
      a.ops[a.ops.length - 1]?.op === "replace" ? (a.ops[a.ops.length - 1] as { targets: string[] }).targets : [],
    altered: [],
    added: [],
    removed: [],
  });
  reevaluate(pool, a);
  lateSweep(pool, a);
  return premises;
}

/** The blast radius of a held submit (10.3): who would break, confirm or triage if it landed. */
export function blast(
  pool: Pool,
  a: Attempt,
): { repair: string[]; confirm: string[]; triage: string[]; right_of_way: string[] } {
  const after = replayOps(curOps(a), pool.files).files;
  const out = { repair: [] as string[], confirm: [] as string[], triage: [] as string[], right_of_way: [] as string[] };
  for (const o of inflight(pool)) {
    if (o === a) continue;
    const res = worst(classify(pool, o, pool.files, after, null, [frozen(a)]));
    if (res !== null) out[res].push(o.id);
  }
  // 10.2 step 4: the entries that hold right of way — `land_now` joins the card's options
  // while one of them sits under `repair` or `confirm`.
  out.right_of_way = [...out.repair, ...out.confirm, ...out.triage].filter(
    (id) => (pool.attempts.get(id)?.right_of_way_at ?? null) !== null,
  );
  return out;
}
