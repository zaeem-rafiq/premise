// src/core/trunk/tick.ts — the accept transaction of 01-core.md 9.4 (the tick), the push
// lifecycle of 9.5 to 9.8 (outbox, landed, reconcile), owner actions (10.3), triage answers
// (7.3), restarts (TR6), undo planning (11.3) and the non-tool calls (4.10-4.12, TA9, RS1).
//
// Everything is synchronous; the driver's `push_ok`/`push_result` steps stand in for the remote.

import type { Operation } from "../../protocol/operations.ts";
import type { PremiseKind } from "../../protocol/premise.ts";
import type { Note } from "../../protocol/note.ts";
import type { ToolError } from "../../protocol/tools.ts";
import type { AgentOpenRequest } from "../../protocol/internal.ts";
import type { Attempt, CardRec, FileMap, Landing, Op, Pool, Premise } from "./sets.ts";
import { curOps, entityAt, entityKeysOf, keyHash, replayOps, setsOf, sourceOf, type ClassifyItem } from "./sets.ts";
import { TIDEPOOL_LANGUAGES } from "../keys/paths.ts";
import type { LanguageSet } from "../keys/paths.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8, bytesToHex } from "../sync/bytes.ts";
import { PUSH_REJECT_LIMIT, TICK_MS } from "../../protocol/constants.ts";
import { landingCommit, notesCommit } from "../git/commit.ts";
import { makeTreeFromFiles, type EntryMode, type FileMode, type FileMapValue } from "../git/tree-files.ts";
import { notesTree } from "../git/notes-tree.ts";
import { makeBlob, makeCommit, type GitObject } from "../git/objects.ts";
import { canonicalJson, noteBytes } from "../git/note.ts";
import { event, emitPoolFiles, emitPoolState, flushEvents } from "./events.ts";
import { buildPack } from "../git/pack.ts";
import {
  clearRightOfWay,
  closeCard,
  frozen,
  grantRightOfWay,
  hasRightOfWay,
  scheduleTick,
  inflight,
  isWaiting,
  openAttempt,
  openCard,
  parked,
  sentBack,
  setState,
  unvalidate,
  setIntentState,
  refreshCardText,
} from "./intents.ts";
import { applyClassification, blast, hItem, sendHeadsUp, worst } from "./landing.ts";
import { classify } from "../classify/table.ts";
import { triageOutcome } from "../classify/triage.ts";
import { closeAsk } from "./triage.ts";
import { policyTier, submitIdOf, changedPaths } from "./submit.ts";
import type { HeadsUpCause } from "./landing.ts";
import { buildsPlain } from "./plain.ts";
import { metaGet } from "./schema.ts";

import { planUndo } from "../undo/plan.ts";
import { confirmUndo, undoPlan } from "./undo-apply.ts";
import { reopen, repairReopened, type Reopened } from "./reopen.ts";
import { batchCauseSeq } from "./cause-seq.ts";

const iso = (ms: number): string => new Date(ms).toISOString();
const utf8len = (s: string): number => utf8(s).length;

// ---------------------------------------------------------------------------
// The write set and the landing record (3.5, 9.4 step 4).

/** The write set of a landing: `file` and `entity` rows for every key whose hash changed. */
export function writeSet(
  before: FileMap,
  after: FileMap,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): {
  w: Array<{ kind: "entity" | "file" | "listing"; key: string }>;
  paths: string[];
} {
  const w: Array<{ kind: "entity" | "file" | "listing"; key: string }> = [];
  const paths = changedPaths(before, after);
  for (const p of paths) {
    w.push({ kind: "file", key: p });
    const kb = entityKeysOf(before, p, languages) ?? [];
    const ka = entityKeysOf(after, p, languages) ?? [];
    for (const k of new Set([...kb, ...ka])) {
      const b = entityAt(before, k, languages);
      const c = entityAt(after, k, languages);
      if (b === null || c === null || b.hash !== c.hash) w.push({ kind: "entity", key: k });
    }
  }
  return { w, paths };
}

/** The `ops` array of a note (3.5): `write` serializes by blob, content or delete. */
function noteOps(ops: readonly Operation[], after: FileMap): Note["ops"] {
  const out: Note["ops"] = [];
  for (const o of ops) {
    if (o.op === "write") {
      if (o.content === null) {
        out.push({ op: "write", path: o.path, delete: true });
        continue;
      }
      const finalContent = after.get(o.path);
      if (finalContent !== undefined && finalContent === o.content) {
        out.push({ op: "write", path: o.path, blob: blobId(utf8(o.content)) });
      } else {
        out.push({ op: "write", path: o.path, content: o.content });
      }
    } else {
      out.push({ op: "replace", path: o.path, old: o.old, new: o.new, targets: o.targets });
    }
  }
  return out;
}

/** The `judgments` array of a note: every judgment recorded for the attempt. */
function noteJudgments(pool: Pool, a: Attempt): Note["judgments"] {
  const out: Note["judgments"] = [];
  for (const j of pool.judgments.values()) {
    if (j.attempt_id !== a.id || j.kind === "check") continue;
    const row: Note["judgments"][number] = {
      kind: j.kind,
      key: j.key,
      old: j.old_hash,
      new: j.new_hash,
      cause_seq: j.cause_seq,
      rule: j.rule,
      class: j.klass,
      result: j.result ?? "holds",
      reason: j.reason,
    };
    if (j.klass === "triage") {
      row.clef = {
        model: j.clef_model ?? "clef",
        p: j.clef_p,
        ...(j.clef_error !== null ? { error: j.clef_error } : {}),
        t_repair: j.t_repair ?? pool.K.T_REPAIR,
        t_confirm: j.t_confirm ?? pool.K.T_CONFIRM,
      };
    }
    out.push(row);
  }
  return out;
}

/** The note of 3.5 for one landing (NT1's canonical JSON follows this shape exactly). */
export function buildNote(
  pool: Pool,
  l: {
    seq: number;
    kind: "change" | "undo" | "revert";
    batch_id: number;
    index: number;
    size: number;
    a: Attempt | null;
    premises: Premise[];
    ops: Operation[];
    after: FileMap;
    writes: Array<{ kind: "entity" | "file" | "listing"; key: string; old_hash: string; new_hash: string }>;
    accepted_at: number;
    undo?: { requested_by: string; undoes: number[]; reopened: string[]; kept_readers: number[] };
  },
): Note {
  const a = l.a;
  const go_arounds: Note["go_arounds"] = [];
  const confirms: Note["confirms"] = [];
  if (a !== null) {
    for (const h of a.heads) {
      const keys = h.body.items.map((i) => ({ kind: i.premise.kind as PremiseKind, key: i.premise.key, rule: i.rule }));
      if (h.result === "repair") {
        go_arounds.push({
          n: h.body.go_around ?? 0,
          hn: h.hn,
          cause: h.body.cause.type,
          cause_seqs: h.body.cause.seqs,
          keys,
          statement: h.statement,
          at: iso(h.created_at),
        });
      } else if (h.result === "confirm") {
        confirms.push({ hn: h.hn, keys, statement: h.statement ?? "", at: iso(h.created_at) });
      }
    }
  }
  const note: Note = {
    v: 1,
    hash_version: "ast1",
    seq: l.seq,
    kind: l.kind,
    change_id: a?.change_id ?? `u_${l.seq}`,
    revision: a?.revision ?? 0,
    intent:
      a === null
        ? null
        : {
            id: a.intent_id,
            text: a.intentText,
            requester: a.requester,
            created_at: iso(pool.intents.get(a.intent_id)?.created_at ?? a.updated_at),
          },
    attempt:
      a === null
        ? null
        : {
            id: a.id,
            agent: a.agent_kind,
            model: a.model,
            repo: a.attempt_repo,
            opened_seq: a.opened_seq,
            steps: pool.steps.get(a.id) ?? a.opCount,
            model_calls: a.model_calls ?? 0,
            tokens_in: a.tokens_in ?? 0,
            tokens_out: a.tokens_out ?? 0,
          },
    summary: a?.summary ?? "",
    premises: l.premises.map((p) => ({
      kind: p.kind,
      key: p.key,
      hash: p.hash,
      seq: p.seq,
      read: p.read,
      edit: p.edit,
      derived: p.derived,
    })),
    writes: l.writes.map((w) => ({ kind: w.kind, key: w.key, old: w.old_hash, new: w.new_hash })),
    ops: noteOps(l.ops, l.after),
    go_arounds,
    confirms,
    judgments: a === null ? [] : noteJudgments(pool, a),
    checks: (a?.checks ?? []).map((c) => ({
      name: c.name,
      ok: true as const,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
    })),
    policy: {
      tier: a?.tier ?? "auto",
      approved_by: a?.approved_by ?? null,
      approved_at: a?.approved_at === null || a?.approved_at === undefined ? null : iso(a.approved_at),
      option: a?.approved_option ?? null,
      risk: a?.policy_risk ?? null,
    },
    pull_backs: a?.pull_backs ?? 0,
    batch: { id: l.batch_id, index: l.index, size: l.size },
    timing: {
      opened_at: iso(a?.updated_at ?? l.accepted_at),
      submitted_at: iso(a?.submitted_at ?? l.accepted_at),
      accepted_at: iso(l.accepted_at),
    },
    ...(l.undo !== undefined ? { undo: l.undo } : {}),
  };
  return note;
}

/**
 * Commit one landing into `pool.landings`/`newLandings`: git objects for the tree, the landing
 * commit and the note, and the row shape of 3.2. `before`/`after` stay in memory for planUndo.
 */
export function recordLanding(
  pool: Pool,
  l: {
    seq: number;
    kind: "change" | "undo" | "revert";
    a: Attempt | null;
    before: FileMap;
    after: FileMap;
    premises: Premise[];
    ops: Op[];
    accepted_at: number;
    undoes?: number[];
    undo?: Note["undo"];
    request_id?: string | null;
    undoTarget?: Landing;
  },
): Landing {
  const { w, paths } = writeSet(l.before, l.after, pool.languages);
  const writes = w.map((x) => ({
    kind: x.kind,
    key: x.key,
    old_hash: keyHash(l.before, x.kind, x.key, pool.languages).hash,
    new_hash: keyHash(l.after, x.kind, x.key, pool.languages).hash,
  }));
  const batch_id = Number(pool.meta.get("next_batch_id") ?? "1");
  // The landing commit (3.5, IR5): the tree is written from `entries` — every path the change
  // does not touch goes by object id, unmanaged entries (a symbolic link, a submodule, a path
  // outside 2.1) included, so the commit's tree differs from its parent only at the changed
  // paths, and the pack holds only the objects the remote does not have yet. `fresh` names the
  // directories the change touches — the root and every ancestor of a changed path — so a
  // directory outside it keeps its stored tree id.
  const changed = new Set(paths);
  const headEntries = pool.entries; // local: the seam guard reads `pool.entries`' writes as table writes
  const filesForTree: Record<string, FileMapValue> = {};
  for (const [path, entry] of headEntries) {
    if (!changed.has(path)) filesForTree[path] = { oid: entry.oid, mode: entry.mode as EntryMode };
  }
  for (const path of changed) {
    const content = l.after.get(path);
    if (content === undefined) continue; // a deleted path is simply absent
    // A change is only ever written to a managed path: its mode is a leaf file mode (a
    // replace keeps `100755`; a `write` of a new file is `100644`; over an existing file, its mode).
    filesForTree[path] = { content, mode: (pool.modes.get(path) ?? "100644") as FileMode };
  }
  const fresh = new Set<string>([""]);
  for (const path of changed) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) fresh.add(segments.slice(0, i).join("/"));
  }
  const {
    root: treeObj,
    objects,
    dirs,
  } = makeTreeFromFiles(filesForTree, {
    stored: pool.trees,
    fresh,
  });
  for (const o of objects) pool.objects.set(o.oid, o);
  // The new head's bookkeeping: changed paths take their new object id, deleted paths leave,
  // and the rebuilt directories' ids are the next landing's `stored`.
  for (const path of changed) {
    const content = l.after.get(path);
    if (content === undefined) {
      headEntries.delete(path);
      pool.modes.delete(path);
    } else {
      const mode = pool.modes.get(path) ?? "100644";
      pool.modes.set(path, mode);
      headEntries.set(path, { oid: blobId(utf8(content)), mode });
      pool.opaque.delete(path); // a landed write gives a formerly opaque blob real content
    }
  }
  for (const [dir, oid] of dirs) {
    if (pool.trees.get(dir) !== oid) {
      pool.trees.set(dir, oid);
      pool.dirtyTrees.add(dir);
    }
  }
  const parent =
    l.seq === 1
      ? (pool.meta.get("head_commit") ?? seedCommit(pool, l.before).oid)
      : (pool.landings[pool.landings.length - 1]?.commit_oid ?? "");
  const undoesCommits = (l.undoes ?? []).map((s) => pool.landings.find((x) => x.seq === s)?.commit_oid ?? "");
  const a = l.a;
  const commitObj = landingCommit({
    tree: treeObj.oid,
    parent,
    authorName:
      a === null ? "Premise Trunk" : a.agent_kind === "synthetic" ? "SYNTHETIC swarm" : (a.model ?? "unknown-model"),
    attemptId: a?.id ?? null,
    acceptedAt: Math.floor(l.accepted_at / 1000),
    summary: a?.summary ?? "",
    intentText: a?.intentText ?? l.undoTarget?.intentText ?? "",
    changeId: a?.change_id ?? `u_${l.seq}`,
    intentId: a?.intent_id ?? l.undoTarget?.intent_id ?? `u_${l.seq}`,
    undoes: undoesCommits,
  });
  pool.objects.set(commitObj.oid, commitObj);
  const note = buildNote(pool, {
    seq: l.seq,
    kind: l.kind,
    batch_id,
    index: pool.newLandings.length,
    size: 0, // size is finalised when the batch commits (NT3)
    a,
    premises: l.premises,
    ops: l.ops,
    after: l.after,
    writes,
    accepted_at: l.accepted_at,
    ...(l.undo !== undefined ? { undo: l.undo } : {}),
  });
  if (l.undoTarget !== undefined) {
    const targetNote = JSON.parse(l.undoTarget.note) as Note;
    note.intent = targetNote.intent;
  }
  const landing: Landing = {
    seq: l.seq,
    kind: l.kind,
    change_id: a?.change_id ?? `u_${l.seq}`,
    attempt_id: a?.id ?? null,
    intent_id: a?.intent_id ?? l.undoTarget?.intent_id ?? null,
    batch_id,
    commit_oid: commitObj.oid,
    parent_oid: parent,
    tree_oid: treeObj.oid,
    note_oid: "",
    note: canonicalJson(note),
    submitted_at: a?.submitted_at ?? null,
    accepted_at: l.accepted_at,
    pushed_at: null,
    undone_by: null,
    files: new Map(
      paths.map((p) => {
        const ob = l.before.get(p);
        const oa = l.after.get(p);
        return [
          p,
          {
            old_oid: ob === undefined ? "absent" : blobId(utf8(ob)),
            new_oid: oa === undefined ? "absent" : blobId(utf8(oa)),
          },
        ] as const;
      }),
    ),
    writes,
    premises: l.premises.map((p) => ({ ...p })),
    ops: l.ops,
    intentText: a?.intentText ?? l.undoTarget?.intentText ?? null,
    request_id: l.request_id ?? null,
    before: l.before,
    after: l.after,
  };
  pool.landings.push(landing);
  pool.newLandings.push(landing);
  return landing;
}

/** The seed commit (3.5): the root commit `main` pointed to when the pool was created. */
export function seedCommit(pool: Pool, files: FileMap): GitObject {
  const filesForTree: Record<string, string> = {};
  for (const [p, c] of files) filesForTree[p] = c;
  const { root, objects, dirs } = makeTreeFromFiles(filesForTree);
  for (const o of objects) pool.objects.set(o.oid, o);
  for (const [dir, oid] of dirs) pool.trees.set(dir, oid);
  const headEntries = pool.entries;
  for (const [path, content] of files) {
    headEntries.set(path, { oid: blobId(utf8(content)), mode: "100644" });
  }
  const commit = makeCommit({
    tree: root.oid,
    parents: [],
    author: { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: Math.floor(pool.now() / 1000) },
    committer: { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: Math.floor(pool.now() / 1000) },
    message: "Premise seed",
  });
  pool.objects.set(commit.oid, commit);
  return commit;
}

/**
 * The objects `roots` reach through `pool.objects` (LP6): commits to their trees and parents,
 * trees to their entries. An object the map does not hold — a parent pushed by an earlier batch
 * and rebuilt out of memory — is simply not in the pack: the remote already has it.
 */
function reachableObjects(pool: Pool, roots: readonly string[]): GitObject[] {
  const out: GitObject[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (oid === "" || seen.has(oid)) return;
    const object = pool.objects.get(oid);
    if (object === undefined) return;
    seen.add(oid);
    out.push(object);
    if (object.type === "commit") {
      for (const line of new TextDecoder().decode(object.content).split("\n")) {
        if (line.startsWith("tree ")) visit(line.slice(5, 45).trim());
        else if (line.startsWith("parent ")) visit(line.slice(7, 47).trim());
        else if (line === "") break;
      }
    } else if (object.type === "tree") {
      const bytes = object.content;
      let i = 0;
      while (i < bytes.length) {
        const space = bytes.indexOf(0x20, i);
        const nul = bytes.indexOf(0, space);
        visit(bytesToHex(bytes.subarray(nul + 1, nul + 21)));
        i = nul + 21;
      }
    }
  };
  for (const root of roots) visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// The tick (9.4).

function schedulePendingTick(pool: Pool): void {
  if (pool.undoQueue.length > 0 || [...pool.attempts.values()].some((a) => a.state === "validated")) {
    scheduleTick(pool, TICK_MS);
  }
}

/** The heads-up cause of a batch landing (8.1). */
function batchCause(batch: Landing[], type: "landing" | "undo" | "revert"): HeadsUpCause {
  return {
    type,
    seqs: batch.map((l) => l.seq),
    changes: batch
      .filter((l) => l.kind === "change")
      .map((l) => ({ seq: l.seq, change_id: l.change_id, intent_text: l.intentText })),
  };
}

/** The accept transaction of 9.4: undo requests, then validated candidates in order. */
export function tick(pool: Pool): void {
  if ((pool.meta.get("pool_state") ?? "ready") !== "ready" || pool.outbox !== null) return;
  // RW1: a mark RIGHT_OF_WAY_MS old has lapsed even if its timer row never fired — the tick
  // sweeps stale grants before it orders candidates, so none can hold RW3's skip open.
  for (const a of pool.attempts.values()) {
    if (!hasRightOfWay(pool, a)) clearRightOfWay(pool, a);
  }
  const pre = pool.files;
  let running = new Map(pre);
  let seq = pool.headSeq();
  const batch: Landing[] = [];
  const causeSeq = batchCauseSeq(pre, batch, pool.languages);
  const reopened: Reopened[] = [];
  pool.eventBuffer = [];

  // Undo requests first (11.3): each queued request becomes one undo landing.
  while (pool.undoQueue.length > 0 && batch.length < pool.K.MAX_BATCH) {
    const u = pool.undoQueue.shift()!;
    // Older stores could queue the same target twice without a frozen set. Never
    // produce a second undo of an already undone landing during that recovery.
    if (u.cause === "undo" && pool.landings.find((l) => l.seq === u.target_seq)?.undone_by != null) {
      u.state = "refused";
      pool.undoLog.set(u.request_id, u);
      pool.dirtyUndo.add(u.request_id);
      event(pool, "undo.refused", { request_id: u.request_id, target_seq: u.target_seq, reason: "already_undone" });
      continue;
    }
    const plan = planUndo(pool, u.target_seq, running, u.cause === "revert" ? u.reverted : undefined);
    const before = running;
    running = plan.files;
    seq += 1;
    const landing = recordLanding(pool, {
      seq,
      kind: u.cause,
      a: null,
      undoTarget: pool.landings.find((l) => l.seq === u.target_seq),
      before,
      after: running,
      premises: [],
      ops: [],
      accepted_at: pool.now(),
      undoes: plan.reverted,
      undo: {
        requested_by: u.requested_by ?? "owner",
        undoes: plan.reverted,
        reopened: plan.reverted
          .filter((s) => u.cause === "revert" || s !== u.target_seq)
          .map((s) => pool.landings.find((l) => l.seq === s)?.attempt_id ?? "")
          .filter((x) => x !== ""),
        kept_readers: plan.kept,
      },
      request_id: u.request_id,
    });
    batch.push(landing);
    pool.out.accepted.push(`undo:${u.target_seq}`);
    pool.out.landings.push({ seq, kind: u.cause, undoes: plan.reverted });
    u.state = "landed";
    pool.undoLog.set(u.request_id, u);
    pool.dirtyUndo.add(u.request_id);
    for (const s of plan.reverted) {
      const x = pool.landings.find((y) => y.seq === s);
      if (x === undefined) continue;
      x.undone_by = seq;
      const a = x.attempt_id === null ? null : pool.attempts.get(x.attempt_id);
      if (a === null || a === undefined) continue;
      if (u.cause === "undo" && s === u.target_seq) {
        setState(pool, a, "stopped", "T18", "undone");
        setIntentState(pool, a.intent_id, "undone");
      } else {
        reopen(pool, a, x, running, u.cause);
        reopened.push({ a, plan, x, cause: u.cause, undoSeq: seq, head: running });
      }
      pool.dirtyAttempts.add(a.id);
    }
  }

  // Candidates (9.3): validated, premises hold, confirm/repair resolved, submit_id current.
  const cands = inflight(pool)
    .filter(
      (a) =>
        a.state === "validated" &&
        [...a.premises.values()].every((p) => p.status === "holds") &&
        a.heads.every((h) => h.result === "info" || h.resolved_at !== null) &&
        a.submit_id === submitIdOf(a),
    )
    .sort(
      (x, y) =>
        (x.right_of_way_at ?? Infinity) - (y.right_of_way_at ?? Infinity) ||
        (x.validated_at ?? 0) - (y.validated_at ?? 0) ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
  const inBatch = new Set<Attempt>();
  const members: Array<{ premises: Premise[]; attempt_id: string }> = [];
  for (const c of cands) {
    if (batch.length >= pool.K.MAX_BATCH) break;
    const after = replayOps(curOps(c), running, {}, pool.languages);
    // 3a right of way: another attempt with an earlier right-of-way mark blocks this candidate
    // when it would get a repair or confirm from this landing.
    let blocked: Attempt | null = null;
    if (after.failed.length === 0 && !c.bypass_row) {
      for (const P of inflight(pool)) {
        if (P === c || inBatch.has(P) || P.right_of_way_at === null) continue;
        if (c.right_of_way_at !== null && c.right_of_way_at < P.right_of_way_at) continue;
        const w = worst(classify(pool, P, running, after.files, null, [frozen(c)]));
        if (w === "repair" || w === "confirm") {
          blocked = P;
          break;
        }
      }
    }
    if (blocked !== null) {
      pool.out.skipped[c.id] = "right_of_way";
      event(pool, "tick.skipped", { attempt_id: c.id, why: "right_of_way", behind: blocked.id });
      continue;
    }
    // 3b disjoint: a dry run over the batch's running tree.
    const cl = classify(pool, c, pre, running, setsOf(c, pre, pool.languages), members);
    if (cl.failed.length > 0 || cl.items.some((i) => i.result !== "holds" && i.result !== "delete")) {
      pool.out.skipped[c.id] = "not_disjoint";
      event(pool, "tick.skipped", { attempt_id: c.id, why: "not_disjoint", behind: null });
      continue;
    }
    // 3c checks against running: non_empty, then the tier under the running policy.
    const changed = changedPaths(running, after.files);
    if (changed.length === 0) {
      pool.out.skipped[c.id] = "checks_failed";
      event(pool, "tick.skipped", { attempt_id: c.id, why: "checks_failed", behind: null });
      const j = pool.newJudgment(c, {
        kind: "check",
        key: "non_empty",
        old_hash: "",
        new_hash: "",
        cause: "landing",
        cause_seq: null,
        rule: "CKL",
        klass: "rule",
        result: "repair",
        reason: "checks_failed_at_landing",
      });
      j.dirty = true;
      pool.out.judgments.push(j);
      sendHeadsUp(
        pool,
        c,
        "repair",
        [
          {
            item: {
              premise: { kind: "check" as Premise["kind"], key: "non_empty" },
              rule: "CKL",
              result: "repair",
              reason: "checks_failed_at_landing",
              old_hash: "",
              new_hash: "",
              cause_seq: null,
              diff: { kind: "check", check: "non_empty", code: "empty_change" },
              uses: [],
            },
            trace: { kind: "check", key: "non_empty", rule: "CKL", result: "repair" },
          },
        ],
        [],
        batchCause(batch, "landing"),
      );
      continue;
    }
    if (policyTier(pool, running, changed) === "held" && c.approved_by === null) {
      pool.out.skipped[c.id] = "held";
      event(pool, "tick.skipped", { attempt_id: c.id, why: "held", behind: null });
      c.tier = "held";
      setState(pool, c, "held", "T4");
      openCard(pool, "held", "held_path", [c.id], {
        blast_radius: pool.featuresHeld ? { [c.id]: blast(pool, c, running, inBatch) } : {},
        head: { files: running, seq },
        submit_ids: c.submit_id === null ? {} : { [c.id]: c.submit_id },
      });
      continue;
    }
    // The candidate lands: its changed premises re-pin at the running tree (holds judgments).
    for (const it of cl.items) {
      if (it.result === "delete") {
        c.premises.delete(`${it.p.kind}|${it.p.key}`);
        event(pool, "premise.removed", { attempt_id: c.id, kind: it.p.kind, key: it.p.key, rule: it.rule ?? "" });
        continue;
      }
      const cur = keyHash(running, it.p.kind, it.p.key, pool.languages);
      it.p.hash = cur.hash;
      it.p.members = cur.members;
      it.p.seq = seq + 1;
      const j = pool.newJudgment(c, {
        kind: it.kind,
        key: it.key,
        old_hash: it.old_hash,
        new_hash: it.new_hash,
        cause: "landing",
        cause_seq: causeSeq(it.kind, it.key),
        rule: it.rule ?? "",
        klass: "rule",
        result: "holds",
        reason: it.reason ?? "",
      });
      pool.out.judgments.push(j);
    }
    const before = running;
    running = after.files;
    seq += 1;
    const landing = recordLanding(pool, {
      seq,
      kind: "change",
      a: c,
      before,
      after: running,
      premises: [...c.premises.values()].map((p) => ({ ...p })),
      ops: curOps(c).map((o) => ({ ...o }) as Op),
      accepted_at: pool.now(),
    });
    batch.push(landing);
    members.push({ premises: landing.premises, attempt_id: c.id });
    inBatch.add(c);
    pool.out.accepted.push(c.id);
    pool.out.landings.push({ seq, attempt: c.id, kind: "change" });
  }
  if (batch.length === 0) {
    pool.out.waiting = cands.filter((c) => pool.out.skipped[c.id] === "right_of_way").length;
    // CD2: even a batch-free tick can move a blast radius — a right-of-way grant lapsed.
    refreshOpenCards(pool);
    flushEvents(pool);
    schedulePendingTick(pool);
    return;
  }

  // 9.4 step 5: the batch commits. Next batch id, landings table, head, outbox.
  const oldMain = pool.meta.get("head_commit") ?? "";
  const oldNotes = pool.meta.get("notes_commit") ?? "";
  // SQLite is authoritative even when the caller retained its Pool. Fail inside the
  // accept transaction before writing a batch or announcing any accepted landing.
  if (
    oldMain !== (metaGet(pool.sql, "head_commit") ?? "") ||
    oldNotes !== (metaGet(pool.sql, "notes_commit") ?? "") ||
    batch[0]!.parent_oid !== oldMain
  )
    throw new Error("batch parent differs from SQLite head");
  if (
    pool.sql.exec("SELECT batch_id FROM outbox WHERE state IN ('pending', 'notes_pending') LIMIT 1").toArray().length >
    0
  )
    throw new Error("batch would replace an unpushed SQLite outbox");
  const batchId = Number(pool.meta.get("next_batch_id") ?? "1");
  pool.meta.set("next_batch_id", String(batchId + 1));
  const causedEvents = pool.eventBuffer;
  pool.eventBuffer = null;
  for (const l of batch) {
    l.batch_id = batchId;
    // NT3: the note is built after the batch is complete — `batch` is final here.
    const note = JSON.parse(l.note) as Note;
    note.batch = { id: batchId, index: batch.indexOf(l), size: batch.length };
    const noteBlob = makeBlob(noteBytes(note));
    pool.objects.set(noteBlob.oid, noteBlob);
    l.note_oid = noteBlob.oid;
    l.note = canonicalJson(note);
    event(pool, "landing.accepted", {
      seq: l.seq,
      batch_id: batchId,
      kind: l.kind,
      attempt_id: l.attempt_id,
      change_id: l.change_id,
      intent_id: l.intent_id,
      request_id: l.request_id,
      paths: [...l.files.keys()],
      writes: l.writes.map((x) => ({ kind: x.kind, key: x.key, old: x.old_hash, new: x.new_hash })),
    });
  }
  pool.eventBuffer = causedEvents;
  for (const l of batch) {
    if (l.attempt_id !== null) {
      const a = pool.attempts.get(l.attempt_id);
      if (a !== undefined) {
        setState(pool, a, "accepted", "T15");
        a.landed_seq = l.seq;
      }
    }
  }
  // EV3: the candidate phase's skipped/judged/removed events follow every landing.accepted.
  flushEvents(pool);
  for (const p of changedPaths(pre, running)) pool.filesChanged.add(p);
  pool.setHead(seq, running);
  // The notes tree and the batch's notes commit (9.5).
  // Unwitnessed landings (a rebuilt pool keeps them, `note_oid` "") have no note to map —
  // and an empty blob id would throw inside `notesTree`'s oid check.
  const mappings = pool.landings
    .filter((l) => l.note_oid !== "")
    .map((l) => ({ commit: l.commit_oid, blob: l.note_oid }));
  const nt = notesTree(mappings);
  for (const o of nt.objects) pool.objects.set(o.oid, o);
  const notes = notesCommit({
    tree: nt.root.oid,
    parent: oldNotes === "" ? null : oldNotes,
    batchId,
    firstSeq: batch[0]!.seq,
    lastSeq: batch[batch.length - 1]!.seq,
    at: Math.floor(pool.now() / 1000),
  });
  pool.objects.set(notes.oid, notes);
  pool.meta.set("notes_commit", notes.oid);
  const newMain = batch[batch.length - 1]!.commit_oid;
  pool.meta.set("head_commit", newMain);
  pool.meta.set("head_seq", String(seq));
  pool.outbox = {
    batch_id: batchId,
    state: "pending",
    first_seq: batch[0]!.seq,
    last_seq: batch[batch.length - 1]!.seq,
    old_main: oldMain,
    new_main: newMain,
    old_notes: oldNotes,
    new_notes: notes.oid,
    tries: 0,
    rejects: 0,
    next_try: null,
    last_error: null,
    created_at: pool.now(),
    pushed_at: null,
    main: false,
    notes: false,
  };
  // LP6: the batch's pack — every object `new_main` and `new_notes` reach that `pool.objects`
  // holds — is stored with the row, so a restart of the object pushes the same bytes.
  pool.outboxPack = buildPack(reachableObjects(pool, [newMain, notes.oid]));
  pool.dirtyOutbox = true;
  // EM1: `head_seq`/`head_commit` changed — `pool.state` is emitted again.
  emitPoolState(pool);
  // EM1: `pool.files` is emitted again after a landing that adds or removes a path or changes
  // the policy.
  const changed = changedPaths(pre, running);
  const addedOrRemoved = [...pre.keys()].some((p) => !running.has(p)) || [...running.keys()].some((p) => !pre.has(p));
  if (addedOrRemoved || changed.includes(".premise/policy.json")) emitPoolFiles(pool);
  // 9.4: the tick fires every TICK_MS while candidates or undo requests remain — the batch that
  // just landed clears LP1's block on the next alarm; work the batch could not take (MAX_BATCH,
  // the budget) ticks again at the cadence.
  schedulePendingTick(pool);

  for (const r of reopened) repairReopened(pool, r, running, seq, batch, causeSeq);

  // Every other in-flight or parked attempt is classified against the batch (9.4 step 6).
  for (const a of [...inflight(pool), ...parked(pool)]) {
    if (inBatch.has(a) || reopened.some((r) => r.a === a)) continue;
    const cl = classify(pool, a, pre, running, null, members);
    // The cause attempt for a contradiction check: the first batch member whose write set
    // touches an E1 key.
    let causeAttempt: Attempt | null = null;
    for (const it of cl.items) {
      if (it.rule === "E1") {
        const l = batch.find((b) => b.writes.some((w) => w.kind === it.kind && w.key === it.key));
        if (l !== undefined && l.attempt_id !== null) causeAttempt = pool.attempts.get(l.attempt_id) ?? null;
      }
    }
    applyClassification(
      pool,
      a,
      cl,
      running,
      seq,
      batchCause(
        batch,
        batch.find((l) => l.kind !== "change")?.kind === "revert"
          ? "revert"
          : batch.some((l) => l.kind === "undo")
            ? "undo"
            : "landing",
      ),
      causeAttempt,
      undefined,
      causeSeq,
    );
  }
  pool.out.waiting = inflight(pool).filter(
    (c) => c.state === "validated" && pool.out.skipped[c.id] === "right_of_way",
  ).length;
  // CD2 (9.4 step 5): the batch changed what an open card's blast radius holds.
  refreshOpenCards(pool);
}

// ---------------------------------------------------------------------------
// The push lifecycle (9.6 to 9.8) — in this build the driver's push steps stand in for the remote.

/** Mark the outbox's landings as on-main: `landing.landed` events and the T17a states. */
export function markLanded(pool: Pool, transition: "T16" | "T17a" = "T16"): void {
  const outbox = pool.outbox;
  if (outbox === null) return;
  let changed = false;
  for (let s = outbox.first_seq; s <= outbox.last_seq; s++) {
    const l = pool.landings.find((x) => x.seq === s);
    if (l === undefined || l.pushed_at !== null) continue;
    l.pushed_at = pool.now();
    pool.out.landed.push(s);
    changed = true;
    event(pool, "landing.landed", {
      seq: s,
      batch_id: outbox.batch_id,
      commit: l.commit_oid,
      tree: l.tree_oid,
      note: l.note_oid,
      note_json: l.note,
      time_to_land_ms: l.submitted_at === null ? null : pool.now() - l.submitted_at,
    });
    if (l.attempt_id !== null) {
      const a = pool.attempts.get(l.attempt_id);
      if (a !== undefined) {
        if (a.state === "accepted") {
          setState(pool, a, "landed", transition);
          setIntentState(pool, a.intent_id, "landed"); // T16/T17a effect: intent -> landed
        }
        clearRightOfWay(pool, a);
        pool.dirtyAttempts.add(a.id);
      }
    }
  }
  if (changed) {
    // EM1: `landed_seq`/`landed_commit` moved — `pool.state` is emitted again.
    pool.meta.set("landed_seq", String(outbox.last_seq));
    const last = pool.landings.find((x) => x.seq === outbox.last_seq);
    if (last !== undefined) pool.meta.set("landed_commit", last.commit_oid);
    emitPoolState(pool);
  }
}

/** `push_ok` (9.8): the whole batch is on both refs. `batch.pushed` precedes `landing.landed`
 * (acceptance stream order: `landing.accepted`, `batch.pushed`, `landing.landed`). */
export function pushOk(pool: Pool): void {
  if (pool.outbox === null) return;
  event(pool, "batch.pushed", {
    batch_id: pool.outbox.batch_id,
    first_seq: pool.outbox.first_seq,
    last_seq: pool.outbox.last_seq,
    main: pool.outbox.new_main,
    notes: pool.outbox.new_notes,
    tries: pool.outbox.tries,
    ms: pool.now() - pool.outbox.created_at,
  });
  markLanded(pool);
  // The plain-merge pool rebuilds off the landing path (11.7, PM6): the `plain` timer
  // carries it — this transaction only arms it, the push never waits on it. An imported pool
  // (IR7) and a summary-only pool have no plain-merge pool: the timer is never armed for them.
  if (buildsPlain(pool)) {
    pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('plain', '', ?)", pool.now());
  }
  pool.outbox.pushed_at = pool.now();
  pool.outbox.state = "pushed";
  pool.outbox = null;
  pool.outboxPack = null;
  pool.dirtyOutbox = true;
  // The outbox that gated the tick (LP1) is clear — the work it blocked runs at the next alarm.
  if (pool.undoQueue.length > 0 || [...pool.attempts.values()].some((x) => x.state === "validated")) {
    scheduleTick(pool);
  }
}

/**
 * LP5/LP7: decide by the values of both remote refs. `remote_main`/`remote_notes` are `"old"`,
 * `"new"` or `"other"` — whether each ref still holds, holds our value, or moved.
 */
export function reconcile(
  pool: Pool,
  remote_main: "old" | "new" | "other",
  remote_notes: "old" | "new" | "other",
): string {
  if (pool.outbox === null) return "none";
  const outbox = pool.outbox;
  if (remote_main === "other" || (remote_main === "old" && remote_notes === "other")) {
    pool.meta.set("pool_state", "paused");
    pool.meta.set("pause_reason", "diverged");
    outbox.state = "diverged";
    event(pool, "pool.paused", { reason: "diverged", detail: outbox.last_error ?? "remote_moved" });
    pool.dirtyOutbox = true;
    return "pause";
  }
  // LP5b: a batch rejected PUSH_REJECT_LIMIT times while both refs kept their old values is
  // poison — the server refused the pack or the commands, never the compare — pause the pool.
  if (
    remote_main === "old" &&
    (remote_notes === "old" || outbox.new_notes === "") &&
    outbox.rejects >= PUSH_REJECT_LIMIT &&
    pool.meta.get("pause_reason") !== "push_rejected"
  ) {
    pool.meta.set("pool_state", "paused");
    pool.meta.set("pause_reason", "push_rejected");
    event(pool, "pool.paused", { reason: "push_rejected", detail: `rejected ${outbox.rejects} times` });
    pool.dirtyOutbox = true;
    return "pause";
  }
  if (remote_main === "old") {
    if (remote_notes === "new") {
      // LP5: the notes command alone applied — `pending` stands (the spec keeps the row state
      // there); the in-memory flag narrows the next request's commands (LP6).
      outbox.notes = true;
      pool.dirtyOutbox = true;
      return "retry_main";
    }
    return "repush";
  }
  // remote_main === "new": the landings are on main.
  if (remote_notes === "new") {
    pushOk(pool);
    return "mark_pushed";
  }
  markLanded(pool, outbox.state === "diverged" ? "T17a" : "T16");
  if (remote_notes === "old") {
    // LP5: `notes_pending` — the next request carries the notes command only.
    outbox.main = true;
    outbox.state = "notes_pending";
    pool.dirtyOutbox = true;
    return "retry_notes";
  }
  pool.meta.set("pool_state", "paused");
  pool.meta.set("pause_reason", "diverged");
  outbox.state = "diverged";
  event(pool, "pool.paused", { reason: "diverged", detail: "notes_moved" });
  pool.dirtyOutbox = true;
  return "pause";
}

/** `restart` (TR6): pending triage judgments are asked again once, then the push state reconciles. */
export function restart(
  pool: Pool,
  args: { remote_main: "old" | "new" | "other"; remote_notes?: "old" | "new" | "other" },
): string {
  for (const j of pool.judgments.values()) {
    if (j.result !== null) continue;
    pool.out.reasked.push({ attempt: j.attempt_id, kind: j.kind, key: j.key });
  }
  // Rebuild the pending list for rows a fresh instance loaded without a frozen item (TR6).
  for (const r of pool.out.reasked) {
    const a = pool.attempts.get(r.attempt);
    if (a === undefined) continue;
    const p = a.premises.get(`${r.kind}|${r.key}`);
    if (p === undefined) continue;
    if (!pool.pendingTriage.some((t) => t.p === p)) {
      const j = [...pool.judgments.values()].find(
        (x) => x.attempt_id === a.id && x.kind === r.kind && x.key === r.key && x.result === null,
      );
      if (j !== undefined) pool.pendingTriage.push({ a, p, judgment: j, it: null, cause: "landing", stamp: a.opCount });
    }
  }
  return reconcile(pool, args.remote_main, args.remote_notes ?? args.remote_main);
}

/** A triage answer as the Worker returns it (TR10): the probability, or null for unavailable,
 * with the `asked_op_seq` it was asked with and what the judgment records (7.5). */
export type TriageAnswer = {
  attempt: string;
  kind: string;
  key: string;
  p?: number | null;
  asked_at_op?: number;
  model?: string;
  ms?: number;
  error?: string;
};

/** A triage answer (7.3): resolve the pending judgment by the thresholds. */
export function triage(pool: Pool, args: TriageAnswer): void {
  const i = pool.pendingTriage.findIndex(
    (t) => t.a.id === args.attempt && t.p.kind === args.kind && t.p.key === args.key,
  );
  if (i < 0 || (args.asked_at_op !== undefined && args.asked_at_op !== pool.pendingTriage[i]!.stamp)) {
    // TR4: decided by rule meanwhile (V7, V7a), or asked for an older patch — the answer is
    // discarded and recorded `stale` on the premise's latest judgment.
    const latest = [...pool.judgments.values()]
      .filter((x) => x.attempt_id === args.attempt && x.kind === args.kind && x.key === args.key)
      .at(-1);
    if (latest !== undefined && args.asked_at_op !== undefined) {
      latest.clef_error = "stale";
      latest.dirty = true;
    }
    return;
  }
  const t = pool.pendingTriage[i]!;
  pool.pendingTriage.splice(i, 1);
  closeAsk(pool, args.attempt, args.kind, args.key);
  const a = t.a;
  const p = t.p;
  const outcome = triageOutcome(pool, args.p ?? null);
  const result = outcome.result;
  p.status = result === "repair" ? "pending_repair" : result === "confirm" ? "pending_confirm" : "holds";
  const j = t.judgment;
  j.result = result;
  j.reason = outcome.reason;
  j.clef_p = args.p ?? null;
  j.clef_model = args.model ?? "clef";
  if (args.ms !== undefined) j.clef_ms = args.ms;
  if (args.error !== undefined) j.clef_error = args.error;
  j.t_repair = pool.K.T_REPAIR;
  j.t_confirm = pool.K.T_CONFIRM;
  j.resolved_at = pool.now();
  j.dirty = true;
  pool.out.judgments.push(j);
  event(pool, "premise.judged", {
    attempt_id: a.id,
    kind: p.kind,
    key: p.key,
    old_hash: j.old_hash,
    new_hash: j.new_hash,
    cause: j.cause,
    cause_seq: j.cause_seq,
    rule: j.rule,
    class: "triage",
    result,
    reason: j.reason,
    clef: { model: j.clef_model, p: args.p ?? null, error: args.error ?? null },
  });
  if (result !== "holds") {
    const it =
      t.it ??
      ({
        p,
        kind: p.kind,
        key: p.key,
        old_hash: j.old_hash,
        new_hash: j.new_hash,
        members: p.members,
        oldMembers: p.members,
        before: pool.files,
        after: pool.files,
        added: [],
        removed: [],
        context: [],
        after_src: p.kind === "entity" ? sourceOf(pool.files, p.key, pool.languages) : null,
        rule: j.rule,
        result,
        reason: j.reason,
      } satisfies ClassifyItem);
    sendHeadsUp(pool, a, result, [hItem(pool, a, it, result, j.cause_seq)], [], {
      type: j.cause,
      seqs: j.cause_seq === null ? [] : [j.cause_seq],
      changes: [],
    });
  }
  if (a.state === "submitted" && [...a.premises.values()].every((q) => q.status === "holds")) {
    setState(pool, a, "validated", "T12");
    a.validated_at = ++pool.order;
  }
  pool.dirtyAttempts.add(a.id);
}

// ---------------------------------------------------------------------------
// Owner actions (10.3, 11.3) and the non-tool calls.

/**
 * CD2: one open card's blast radius re-computed against the pool as it stands — "if it landed
 * now" — with the card's text and options refreshed under it (the `land_now` option of 10.2
 * step 4 joins and leaves here). Emits `card.updated` when a field changed.
 */
function refreshCardBlast(pool: Pool, c: CardRec): void {
  let changed = false;
  for (const id of c.attempt_ids) {
    const a = pool.attempts.get(id);
    if (a === undefined || a.state !== "held" || c.body.blast_radius[id] === undefined) continue;
    const next = blast(pool, a);
    if (JSON.stringify(next) !== JSON.stringify(c.body.blast_radius[id])) {
      c.body.blast_radius[id] = next;
      changed = true;
    }
  }
  if (refreshCardText(pool, c)) changed = true;
  if (changed) {
    pool.dirtyCards.add(c.card_id);
    event(pool, "card.updated", { card: c.body });
  }
}

/** CD2: every open held or race card's blast radius again, while the card is open. */
export function refreshOpenCards(pool: Pool): void {
  for (const c of pool.cards) {
    if (!c.open || c.kind === "choice") continue;
    refreshCardBlast(pool, c);
  }
}

export function owner(
  pool: Pool,
  args: {
    action: string;
    attempt?: string;
    seq?: number;
    expect_reverted?: number[];
    reason?: string;
    new_attempt_model?: string;
  },
): Record<string, unknown> {
  const action = args.action;
  const bad = (message: string): Record<string, unknown> => ({
    ok: false,
    error: { code: "invalid_args", message },
  });
  const closeOwned = (c: CardRec, opt: string, attempt_id: string | null = null): void => {
    c.open = false;
    c.closed_at = pool.now();
    pool.dirtyCards.add(c.card_id);
    event(pool, "card.closed", {
      card_id: c.card_id,
      action: opt,
      by: "owner",
      attempt_id,
      reason: opt === "decline" || opt === "choose" ? (args.reason ?? null) : null,
    });
  };
  // CD4: an option the card does not offer is refused; a tap on a card that is not open does
  // nothing (C34's stale card).
  const offered = (c: CardRec, id: string): boolean => c.body.options.some((o) => o.id === id);

  if (action === "land" || action === "land_now" || action === "decline") {
    const a = pool.attempts.get(args.attempt ?? "");
    if (a === undefined) return {};
    const card = pool.cards.find((c) => c.open && c.kind === "held" && c.attempt_ids.includes(a.id));
    if (card === undefined) return {};
    // 10.2 step 4: the blast radius is recomputed when the owner taps — `land_now` stands in
    // `options` exactly while an attempt with right of way sits under `repair` or `confirm`.
    refreshCardBlast(pool, card);
    if (!offered(card, action)) return bad(`card ${card.card_id} does not offer ${action}`);
    if (action === "decline") {
      // T14: the owner's decline stops the held attempt.
      closeOwned(card, "decline");
      setState(pool, a, "stopped", "T14", "declined");
      return {};
    }
    // T13: a held attempt lands when the owner taps; `land_now` also bypasses right of way (RW5).
    if (
      a.state === "held" &&
      [...a.premises.values()].every((p) => p.status === "holds") &&
      a.heads.every((h) => h.resolved_at !== null) &&
      a.submit_id === submitIdOf(a)
    ) {
      closeOwned(card, action);
      a.approved_by = "owner";
      a.approved_at = pool.now();
      a.approved_option = action;
      a.policy_risk = card.body.risk ?? null;
      pool.meta.set(
        `approved:${a.id}`,
        JSON.stringify({ at: a.approved_at, option: a.approved_option, risk: a.policy_risk }),
      );
      a.bypass_row = action === "land_now";
      setState(pool, a, "validated", "T13");
      a.validated_at = ++pool.order;
    }
    return {};
  }
  if (action === "choose") {
    // RC7: the chosen race candidate is approved; the others stop as `not_chosen` (T14).
    const chosen = pool.attempts.get(args.attempt ?? "");
    if (chosen === undefined) return {};
    const card = pool.cards.find((c) => c.open && c.kind === "race" && c.attempt_ids.includes(chosen.id));
    if (card !== undefined) {
      for (const id of card.attempt_ids) {
        if (id === chosen.id) continue;
        const x = pool.attempts.get(id);
        if (x !== undefined && x.state !== "stopped") setState(pool, x, "stopped", "T14", "not_chosen");
      }
      card.open = false;
      card.closed_at = pool.now();
      pool.dirtyCards.add(card.card_id);
      event(pool, "card.closed", {
        card_id: card.card_id,
        action: "choose",
        by: "owner",
        attempt_id: chosen.id,
        reason: args.reason ?? null,
      });
    }
    chosen.race = false;
    if (
      chosen.state === "held" &&
      [...chosen.premises.values()].every((p) => p.status === "holds") &&
      chosen.heads.every((h) => h.resolved_at !== null) &&
      chosen.submit_id === submitIdOf(chosen)
    ) {
      chosen.approved_by = "owner";
      chosen.approved_at = pool.now();
      chosen.approved_option = "choose";
      chosen.policy_risk = card?.body.risk ?? null;
      pool.meta.set(
        `approved:${chosen.id}`,
        JSON.stringify({ at: chosen.approved_at, option: chosen.approved_option, risk: chosen.policy_risk }),
      );
      setState(pool, chosen, "validated", "T13");
      chosen.validated_at = ++pool.order;
    }
    return {};
  }
  if (action === "undo") {
    const request_id = `u_${String(pool.undoCounter++).padStart(4, "0")}`;
    const result = confirmUndo(pool, {
      seq: args.seq ?? 0,
      request_id,
      expect_reverted: args.expect_reverted ?? planUndo(pool, args.seq ?? 0, pool.files).reverted,
    });
    if (!result.ok) return { refused: result.reason, ...(result.plan ? { undo: result.plan } : {}) };
    const plan = undoPlan(pool, args.seq ?? 0);
    return plan.ok ? { undo: plan.plan } : {};
  }
  if (action === "retry" || action === "stop" || action === "keep_landed" || action === "new_attempt") {
    const a = pool.attempts.get(args.attempt ?? "");
    if (a === undefined) return {};
    const card = pool.cards.find((c) => c.open && c.kind === "choice" && c.attempt_ids.includes(a.id));
    if (card === undefined) return {};
    if (!offered(card, action)) return bad(`card ${card.card_id} does not offer ${action}`);
    if (action !== "retry") {
      if (action === "new_attempt" && !args.new_attempt_model) return bad("new_attempt requires the workhorse model");
      closeOwned(card, action);
      let newAttempt: AgentOpenRequest | undefined;
      if (action === "new_attempt") {
        // UN6a: a fresh real Agent starts from the same intent, never the old transcript.
        const intent = pool.intents.get(a.intent_id);
        const n = [...pool.attempts.values()].filter((x) => x.intent_id === a.intent_id).length;
        const opened = openAttempt(pool, `${a.id}~${n}`, {
          intent_id: a.intent_id,
          intent: intent?.text ?? "",
          requester: intent?.requester ?? a.requester,
          agent_kind: "real",
          model: args.new_attempt_model,
          race: false,
        });
        setIntentState(pool, a.intent_id, "open");
        const source = pool.meta.get("source");
        newAttempt = {
          attempt_id: opened.id,
          intent_id: opened.intent_id,
          change_id: opened.change_id,
          intent_text: opened.intentText,
          requester: opened.requester,
          pool: pool.meta.get("pool_id"),
          agent_kind: "real",
          driver: "model",
          model: opened.model,
          ...(pool.meta.get("app") === "" && source
            ? {
                imported: {
                  guide_path: pool.meta.get("guide_path") ?? "",
                  source,
                  branch: pool.meta.get("branch") ?? "",
                },
              }
            : {}),
        };
        // Persist delivery in the same transaction as the card and attempt. A restart
        // between the commit and the first /open call must still start the new Agent.
        pool.meta.set(`new_agent_open:${opened.id}`, JSON.stringify(newAttempt));
        pool.sql.exec(
          "INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('resume', ?, ?)",
          opened.id,
          pool.now(),
        );
      }
      // GL3a: a card that closes with any option other than `retry` deletes the parked
      // attempt's premises and operations; the intent stops when no other attempt of it is in
      // flight or landed (CD4).
      for (const pr of a.premises.values()) {
        event(pool, "premise.removed", { attempt_id: a.id, kind: pr.kind, key: pr.key, rule: "GL3a" });
      }
      a.premises.clear();
      a.ops.length = 0;
      pool.dirtyAttempts.add(a.id);
      const intent = pool.intents.get(a.intent_id);
      if (
        intent !== undefined &&
        ![...pool.attempts.values()].some((x) => x.intent_id === a.intent_id && x !== a && x.state !== "stopped")
      ) {
        setIntentState(pool, a.intent_id, "stopped");
      }
      return newAttempt === undefined ? {} : { new_attempt: newAttempt };
    }
    // T21: the owner retries a stopped attempt that holds a choice card.
    closeOwned(card, "retry");
    a.go_arounds = 0;
    a.pull_backs = 0;
    grantRightOfWay(pool, a);
    a.stop_reason = null;
    const open = a.heads.filter((h) => h.resolved_at === null);
    if (open.some((h) => h.result === "repair")) {
      a.go_arounds = 1;
      setState(pool, a, "going_around", "T21");
    } else if (open.length > 0) {
      setState(pool, a, "needs_confirm", "T21");
    } else {
      setState(pool, a, "working", "T21");
    }
    if (card.reason === "revert_limit") {
      a.revision += 1;
      a.opsFirstDone = false;
    }
    a.resumes += 1;
    pool.meta.set(`resume_cause:${a.id}`, "retry");
    setIntentState(pool, a.intent_id, "open");
    event(pool, "attempt.reopened", { attempt_id: a.id, cause: "retry", revision: a.revision, model_changed: false });
    pool.dirtyAttempts.add(a.id);
    return {};
  }
  return bad(`unknown owner action: ${action}`);
}
