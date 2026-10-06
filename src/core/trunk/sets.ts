// src/core/trunk/sets.ts — the working state the engine's modules pass around, and the set
// computations of 01-core.md 5 and 6.3: the attempt view (replay), the module analysis of one
// file map, and Added / Altered / NewRefs / ModuleRefs / AddedRefs / Edited.
//
// Every function is pure and synchronous. File maps are `Map<string, string>` (path -> content):
// one at head and one per file state the engine needs. The attempt record mirrors the columns of
// 3.2; the engine loads it from SQLite at the start of a call and persists it at the end.

import type { Sql, SyncTriage } from "../../protocol/ports.ts";
import type { Operation } from "../../protocol/operations.ts";
import type { AttemptState } from "../../protocol/attempt.ts";
import type { Check } from "../../protocol/tools.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Card, CardKind, CardReason, RiskAnswers } from "../../protocol/cards.ts";
import type { PremiseKind } from "../../protocol/premise.ts";
import { ABSENT } from "../../protocol/premise.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { isModulePath, parentKey, TIDEPOOL_LANGUAGES } from "../keys/paths.ts";
import type { LanguageSet } from "../keys/paths.ts";
import { membersHash, listingMembers } from "../keys/members.ts";
import { textMembers as textMembersOf, matchContainers, occurrences } from "../keys/search.ts";
import { parseModule, entitySource, outlineLines, moduleHash, type ModuleInfo } from "../entities/entities.ts";
import { analyse, referrersOf, refsMembers, type Analysis } from "../refs/refs.ts";
import { replay } from "../replay/replay.ts";
import type { GitObject } from "../git/objects.ts";

// ---------------------------------------------------------------------------
// The working state.

export type FileMap = Map<string, string>;

/** A premise row (3.2), loaded into memory. `members` and `shown` are decoded from JSON. */
export type Premise = {
  kind: PremiseKind;
  key: string;
  hash: string;
  seq: number;
  members: string[] | null;
  /** What the agent's context holds (3.2 `shown`): a hash for `file`/`entity`, names for `listing`. */
  shown: string | string[] | null;
  read: boolean;
  edit: boolean;
  derived: boolean;
  status: "holds" | "pending_triage" | "pending_confirm" | "pending_repair";
};

export type Op = Operation & { dropped: boolean };

export type Head = {
  hn: number;
  result: "info" | "confirm" | "repair";
  wake: boolean;
  body: HeadsUp;
  created_at: number;
  received_at: number | null;
  delivered_at: number | null;
  resolved_at: number | null;
  statement: string | null;
  op_mark: number;
};

/** The fields of the decision-table item a judgment freezes for later re-evaluation (V7). */
export type JudgmentItem = {
  beforeSeq: number; // head seq whose file map `before` comes from
  afterSeq: number; // head seq whose file map `after` comes from
};

export type Judgment = {
  judgment_id: number;
  attempt_id: string;
  kind: PremiseKind | "check";
  key: string;
  old_hash: string;
  new_hash: string;
  cause: "landing" | "submit" | "undo" | "revert";
  cause_seq: number | null;
  rule: string;
  klass: "rule" | "triage";
  result: "holds" | "confirm" | "repair" | null; // null while a triage answer is pending
  asked_op_seq: number | null;
  asked_at: number | null;
  tries: number;
  reason: string;
  clef_model: string | null;
  clef_p: number | null;
  clef_ms: number | null;
  clef_error: string | null;
  t_repair: number | null;
  t_confirm: number | null;
  created_at: number;
  resolved_at: number | null;
  /** Set when the row changed during this call and must be persisted. */
  dirty: boolean;
  /** For a pending triage: where the frozen maps of the classification live (V7). */
  item: JudgmentItem | null;
};

export type Attempt = {
  id: string;
  intent_id: string;
  change_id: string;
  agent_kind: "real" | "synthetic";
  model: string | null;
  race: boolean;
  truth: string[] | null;
  resumes: number;
  state: AttemptState;
  stop_reason: string | null;
  go_arounds: number;
  pull_backs: number;
  revision: number;
  right_of_way_at: number | null;
  opened_seq: number;
  submit_id: string | null;
  summary: string | null;
  tier: "auto" | "held" | null;
  approved_by: string | null;
  approved_at: number | null; // approval time; persisted in meta for the note's policy block
  approved_option: "land" | "land_now" | "choose" | null;
  policy_risk: RiskAnswers | null; // the approving card's risk answers at approval
  bypass_row: boolean;
  submitted_at: number | null;
  validated_at: number | null;
  landed_seq: number | null;
  attempt_repo: string | null;
  // TA10: the last usage block a real Agent's ToolRequest carried — running totals at the
  // moment of that call; a synthetic attempt's stay 0. Frozen into the note at landing.
  // Optional on the type so an Attempt built outside openAttempt (the classify
  // table's fixtures) needs no usage; every persisted attempt stores 0s.
  model_calls?: number;
  tokens_in?: number;
  tokens_out?: number;
  last_call_id: string | null;
  last_response: Record<string, unknown> | null; // stored response, without heads_ups (TA2)
  ack: number;
  next_hn: number;
  updated_at: number;
  // Working data:
  intentText: string;
  requester: string;
  opCount: number;
  op_mark: number | null; // op_seq when the current go-around started (HU12)
  premises: Map<string, Premise>; // "kind|key"
  ops: Op[];
  heads: Head[];
  resolved: Set<number>; // hn of heads_ups acknowledged by a submit (CK1)
  e1: Set<string>; // entity keys that gave this attempt an E1 repair judgment (GL3)
  checks: Check[] | null; // the checks of the submit that set submit_id (the note copies them)
  opsFirstDone: boolean; // PM2: ops_first already written for this revision
  pending: Judgment[]; // pending triage judgments of this attempt
  dirtyJudgments: Set<number>; // judgment_ids changed this call
};

/** The frozen record of one landing (3.2 `landings` + its companion tables). */
export type Landing = {
  seq: number;
  kind: "change" | "undo" | "revert";
  change_id: string;
  attempt_id: string | null;
  intent_id: string | null;
  batch_id: number;
  commit_oid: string;
  parent_oid: string;
  tree_oid: string;
  note_oid: string;
  note: string;
  submitted_at: number | null;
  accepted_at: number;
  pushed_at: number | null;
  undone_by: number | null;
  files: Map<string, { old_oid: string; new_oid: string }>;
  writes: Array<{ kind: "entity" | "file" | "listing"; key: string; old_hash: string; new_hash: string }>;
  premises: Premise[]; // frozen at acceptance
  ops: Op[]; // the attempt's current operations at acceptance
  intentText: string | null;
  request_id: string | null; // the undo request that made an undo/revert landing
  before: FileMap; // head map just before this landing (rebuilt on open)
  after: FileMap; // head map right after it
};

export type CardRec = {
  card_id: string;
  kind: CardKind;
  open: boolean;
  body: Card;
  created_at: number;
  closed_at: number | null;
  reason: CardReason;
  attempt_ids: string[];
  intent_ids: string[];
};

export type OutboxRow = {
  batch_id: number;
  state: "pending" | "notes_pending" | "pushed" | "diverged";
  first_seq: number;
  last_seq: number;
  old_main: string;
  new_main: string;
  old_notes: string;
  new_notes: string;
  tries: number;
  rejects: number;
  next_try: number | null;
  last_error: string | null;
  created_at: number;
  pushed_at: number | null;
  main: boolean; // the next push carries the main command (LP6)
  notes: boolean; // the next push carries the notes command
};

export type UndoRequest = {
  request_id: string;
  target_seq: number;
  cause: "undo" | "revert";
  state: "queued" | "landed" | "refused";
  requested_by: string | null;
  reverted?: number[];
};

export type IntentRec = {
  intent_id: string;
  text: string;
  requester: string;
  race: boolean;
  state: "open" | "landed" | "stopped" | "undone";
  created_at: number;
};

/** A pending triage question (7.3): the judgment row plus the frozen classification item (V7). */
export type PendingTriage = {
  a: Attempt;
  p: Premise;
  judgment: Judgment;
  it: ClassifyItem | null; // null for a pending row loaded after a rebuild (TR6 re-asks it)
  cause: "landing" | "submit" | "undo" | "revert";
  stamp: number; // op_seq count when asked (V7 stale-answer check)
};

/** The classification working item (one changed premise), internal shape. */
export type ClassifyItem = {
  p: Premise;
  kind: Premise["kind"];
  key: string;
  old_hash: string;
  new_hash: string;
  members: string[] | null;
  oldMembers: string[] | null;
  before: FileMap;
  after: FileMap;
  after_src?: string | null;
  changed?: string[];
  added?: string[];
  removed?: string[];
  context?: string[];
  rule?: string;
  result?: "holds" | "info" | "confirm" | "repair" | "triage" | "delete";
  reason?: string;
  folded?: boolean;
  /** Row QR4: the attempt of the landed change that read the key. Its truth list and its frozen
   * premise decide the triage, not the receiver's (01-core TR8, SW5). */
  decider?: string;
};

/** The per-call result surface a driver or caller inspects (mirrors Appendix A's `expect`). */
export type Trace = {
  judgments: Judgment[];
  heads_ups: Array<{
    to: string;
    hn: number;
    result: string;
    cause: string;
    wake: boolean;
    items: unknown[];
    dropped_ops: unknown[];
  }>;
  cards: Array<{
    kind: CardKind;
    reason: CardReason;
    attempts: string[];
    blast_radius?: unknown;
    candidates?: unknown;
    [k: string]: unknown;
  }>;
  events: string[];
  accepted: string[];
  skipped: Record<string, string>;
  landings: Array<{ seq: number; attempt?: string; kind: string; undoes?: number[] }>;
  landed: number[];
  reasked: Array<{ attempt: string; kind: string; key: string }>;
  waiting: number;
};

/** Everything the engine loads for one call, in memory (the call runs in one transaction). */
export type Pool = {
  sql: Sql;
  now: () => number;
  ids: { next(kind: string): string };
  K: { GO_AROUND_LIMIT: number; STARVATION_AFTER: number; MAX_BATCH: number; T_REPAIR: number; T_CONFIRM: number };
  clefOn: boolean; // switches.CLEF_TRIAGE === "on"
  killed: boolean; // the kill switch (SE10) as the pool last heard it: OffTriage (TR5)
  syncTriage: SyncTriage | null; // the pool's synchronous triage port (S6a): ScriptedTriage
  featuresHeld: boolean; // features.held (FJ1): the full held form; false gives HD1's minimal
  meta: Map<string, string>;
  /** The pool's language set (LG1): the tide-pool set for a seeded pool, the imported set for
   * one made from a repository — `meta.app` is "" exactly in the imported case. */
  languages: LanguageSet;
  files: FileMap; // head: path -> content — MANAGED entries only (IR5)
  modes: Map<string, string>; // head: path -> mode, a mirror of the files rows
  /** Every head-tree entry — managed and unmanaged (IR5: path, mode, object id). `files`
   * holds the managed half; a landing's tree is built from `entries`, so unmanaged paths
   * (a symbolic link, a submodule, a path outside 2.1) survive every commit untouched. */
  entries: Map<string, { oid: string; mode: string }>;
  /** Managed paths whose imported blob exceeded MAX_FILE_BYTES (RB4): content NULL, tools
   * answer `too_large`. They appear in `files` with empty content; this set is the mark. */
  opaque: Set<string>;
  /** The `trees` table in memory: directory ("" is the root, "a/b" a nested one) -> the tree
   * object id at head — the landing overlay's store of unchanged subtrees (IR5). */
  trees: Map<string, string>;
  dirtyTrees: Set<string>; // dirs whose `trees` row must be written
  attempts: Map<string, Attempt>;
  landings: Landing[];
  cards: CardRec[];
  outbox: OutboxRow | null;
  /** The batch's pack bytes, stored with the row in `outbox_chunks` at the same transaction (LP6). */
  outboxPack: Uint8Array | null;
  undoQueue: UndoRequest[];
  order: number; // landing-candidate order counter
  out: Trace;
  dirtyAttempts: Set<string>;
  dirtyCards: Set<string>;
  dirtyOutbox: boolean;
  dirtyUndo: Set<string>;
  newLandings: Landing[];
  /** The persisted row of each landing as `landingMark` read it (load or last persist): a save
   * writes a landing again only when its mark changed (its push, its undo). */
  landingMarks: Map<number, string>;
  filesChanged: Set<string>; // paths the batch changed at head
  entitiesChanged: Set<string>; // module paths whose entities/refs must be rewritten
  analyses: Map<FileMap, Analysis>;
  judgmentsCounter: number; // next judgment_id
  eventCounter: number; // next event n
  cardCounter: number;
  attemptCounter: number;
  undoCounter: number;
  intents: Map<string, IntentRec>;
  dirtyIntents: Set<string>;
  pendingTriage: PendingTriage[];
  judgments: Map<number, Judgment>;
  /** EV3: while non-null, `event()` buffers {type, fields, opts} here; `flushEvents` emits them. */
  eventBuffer: Array<{ type: string; fields: Record<string, unknown>; opts?: { headsup?: boolean } }> | null;
  headSeq(): number;
  setHead(seq: number, files: FileMap): void;
  event(type: string, fields: Record<string, unknown>): void;
  dropPendingItem(a: Attempt, p: Premise): void;
  newJudgment(
    a: Attempt,
    j: {
      kind: Judgment["kind"];
      key: string;
      old_hash: string;
      new_hash: string;
      cause: Judgment["cause"];
      cause_seq: number | null;
      rule: string;
      klass: "rule" | "triage";
      result: Judgment["result"];
      reason: string;
      asked_op_seq?: number | null;
      heads_up?: boolean; // EV6: a heads-up item carries this judgment
      clef?: { model: string; p: number | null; error: string | null };
    },
  ): Judgment;
  fileMapAt(seq: number): FileMap;
  steps: Map<string, number>;
  stepOf(a: Attempt): number;
  objects: Map<string, GitObject>;
  undoLog: Map<string, UndoRequest>; // every undo request, including landed/refused ones
};

export function beginTrace(): Trace {
  return {
    judgments: [],
    heads_ups: [],
    cards: [],
    events: [],
    accepted: [],
    skipped: {},
    landings: [],
    landed: [],
    reasked: [],
    waiting: 0,
  };
}

// ---------------------------------------------------------------------------
// File-map helpers (01-core 2).

export const dirOf = (p: string): string => parentKey(p);
export const pathOf = (k: string): string => k.split("#")[0] ?? k;
export const isModule = isModulePath;

const moduleCache = new WeakMap<FileMap, Map<LanguageSet, Analysis>>();

/** The module analysis (6.2) of one file map under `languages`; cached per map identity and
 * set inside a call. The default is the tide-pool set, so a caller without the pool's set
 * keeps the `.js`/`.mjs` behaviour (LG1). */
export function an(files: FileMap, languages: LanguageSet = TIDEPOOL_LANGUAGES): Analysis {
  let bySet = moduleCache.get(files);
  const got = bySet?.get(languages);
  if (got !== undefined) return got;
  const made = analyse(files, languages);
  if (bySet === undefined) {
    bySet = new Map();
    moduleCache.set(files, bySet);
  }
  bySet.set(languages, made);
  return made;
}

export function entityAt(files: FileMap, key: string, languages: LanguageSet = TIDEPOOL_LANGUAGES) {
  const path = pathOf(key);
  const name = key.slice(key.indexOf("#") + 1);
  const mod = an(files, languages).modules.get(path);
  if (mod === undefined) return null;
  return mod.entities.find((e) => e.name === name) ?? null;
}

export function entityKeysOf(
  files: FileMap,
  path: string,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): string[] | null {
  const mod = an(files, languages).modules.get(path);
  if (mod === undefined) return null;
  return mod.entities.map((e) => `${path}#${e.name}`);
}

export function moduleHashOf(files: FileMap, path: string, languages: LanguageSet = TIDEPOOL_LANGUAGES): string {
  const mod = an(files, languages).modules.get(path);
  return mod === undefined ? "" : moduleHash(mod);
}

export function listingOf(files: FileMap, dir: string): string[] {
  return listingMembers(files, dir);
}

/** The target keys (EN6) of `[start, end)` in a module, or `[path]` for an opaque file. */
export function targetsOf(
  files: FileMap,
  path: string,
  start: number,
  end: number,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): string[] {
  const mod = isModulePath(path, languages) ? an(files, languages).modules.get(path) : undefined;
  if (mod === undefined) return [path];
  const names: string[] = [];
  for (const r of mod.regions) {
    if (start < r.end && end > r.start) {
      for (const n of r.names) if (!names.includes(n)) names.push(n);
    }
  }
  return names.map((n) => `${path}#${n}`);
}

/** The source of an entity (EN7) inside one file map, or null. */
export function sourceOf(files: FileMap, key: string, languages: LanguageSet = TIDEPOOL_LANGUAGES): string | null {
  const path = pathOf(key);
  const name = key.slice(key.indexOf("#") + 1);
  const mod = an(files, languages).modules.get(path);
  if (mod === undefined) return null;
  const content = files.get(path);
  if (content === undefined) return null;
  return entitySource(content, mod, name);
}

/** `containers -> match count` of a literal text search over `files` under `scope` (2.6). */
export function textCounts(
  files: FileMap,
  scope: string,
  needle: string,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, content] of files) {
    if (!(scope === "/" || path === scope || (scope.endsWith("/") && path.startsWith(scope)))) continue;
    for (const [container, count] of matchContainers(path, content, needle, languages)) {
      out.set(container, (out.get(container) ?? 0) + count);
    }
  }
  return out;
}

/** The `refs:` query members (2.5) of `key` inside `files`. */
export function refsMembersOf(files: FileMap, key: string, languages: LanguageSet = TIDEPOOL_LANGUAGES): string[] {
  return refsMembers(key, an(files, languages));
}

/** The `outline:` query members (2.7) of `path`, or null when `path` is absent. */
export function outlineMembersOf(
  files: FileMap,
  path: string,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): string[] | null {
  const mod = an(files, languages).modules.get(path);
  if (mod === undefined) return files.has(path) ? [] : null;
  return outlineLines(mod).sort();
}

/**
 * The hash of one premise key inside `files` (2.5), with the members the hash was made of for
 * the listing and query kinds. `absent` is the `ABSENT` marker.
 */
export function keyHash(
  files: FileMap,
  kind: PremiseKind,
  key: string,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): { hash: string; members: string[] | null } {
  if (kind === "entity") {
    const e = entityAt(files, key, languages);
    return { hash: e === null ? ABSENT : e.hash, members: null };
  }
  if (kind === "file") {
    const content = files.get(key);
    return { hash: content === undefined ? ABSENT : blobId(utf8(content)), members: null };
  }
  if (kind === "listing") {
    const members = listingOf(files, key);
    return { hash: membersHash(members), members };
  }
  // query
  let members: string[];
  if (key.startsWith("text:")) {
    const rest = key.slice(5);
    const i = rest.indexOf(":");
    members = textMembersOf(files, rest.slice(0, i), rest.slice(i + 1), languages);
  } else if (key.startsWith("refs:")) {
    members = refsMembersOf(files, key.slice(5), languages);
  } else {
    const path = key.slice(8); // "outline:<path>"
    const lines = outlineMembersOf(files, path, languages);
    if (lines === null) return { hash: ABSENT, members: [] };
    members = lines;
  }
  return { hash: membersHash(members), members };
}

// ---------------------------------------------------------------------------
// The attempt view and the sets of 6.3.

export const curOps = (a: Attempt): Op[] => a.ops.filter((o) => !o.dropped);

export type ReplayOut = { files: FileMap; failed: Array<{ op_seq: number; path: string; rule: string }> };

/**
 * `replay(ops, tree)` as the attempt view applies it (5.2, 5.3): every operation in order; an
 * operation that no longer applies is reported with its OP rule, and every later operation on the
 * same path is skipped (OP6). A path that failed keeps the input tree's content in the result.
 */
export function replayOps(
  ops: readonly Op[],
  tree: FileMap,
  opts: { noOP5?: boolean; noOP3?: boolean } = {},
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
): ReplayOut {
  // `an` caches the module analysis of a file map by map identity, so the working map is
  // replaced — never mutated — and every snapshot `targetsOf` sees stays true for that object.
  let files = new Map(tree);
  const failed: ReplayOut["failed"] = [];
  const badPaths = new Set<string>();
  const put = (path: string, content: string | undefined): void => {
    files = new Map(files);
    if (content === undefined) files.delete(path);
    else files.set(path, content);
  };
  for (const o of ops) {
    if (badPaths.has(o.path)) continue;
    let rule: string | null = null;
    if (o.op === "write") {
      // OP5 applies to every write, against the tree the replay started from (5.3, C56).
      const head = tree.get(o.path);
      const cur = head === undefined ? ABSENT : blobId(utf8(head));
      if (!opts.noOP5 && cur !== o.base_oid) rule = "OP5";
      if (rule === null) put(o.path, o.content === null ? undefined : o.content);
    } else {
      const content = files.get(o.path);
      if (content === undefined) rule = "OP4";
      else {
        const occ = occurrences(content, o.old);
        if (occ.length === 0) rule = "OP1";
        else if (occ.length > 1) rule = "OP2";
        else {
          const t = targetsOf(files, o.path, occ[0]!, occ[0]! + o.old.length, languages);
          if (!opts.noOP3 && JSON.stringify(t) !== JSON.stringify(o.targets)) rule = "OP3";
          else put(o.path, content.slice(0, occ[0]) + o.new + content.slice(occ[0]! + o.old.length));
        }
      }
    }
    if (rule !== null) {
      failed.push({ op_seq: o.op_seq, path: o.path, rule });
      badPaths.add(o.path);
    }
  }
  if (failed.length > 0) {
    for (const p of badPaths) {
      const original = tree.get(p);
      put(p, original);
    }
  }
  return { files, failed };
}

/** The attempt view (5.2): current operations replayed over `tree` (head by default). */
export function view(a: Attempt, tree: FileMap, languages: LanguageSet = TIDEPOOL_LANGUAGES): FileMap {
  return replayOps(curOps(a), tree, {}, languages).files;
}

export type Sets = {
  /** The language set these sets were computed under (LG1): the pool's own. */
  languages: LanguageSet;
  view: FileMap;
  Added: string[];
  Altered: string[];
  NewRefs: Set<string>;
  ModuleRefs: Set<string>;
  AddedRefs: Set<string>;
  Negatives: Set<string>;
  Edited: Set<string>;
  A: Analysis; // analysis of the view
  Hd: Analysis; // analysis of the head tree
  paths: Set<string>; // touched paths
};

/** The sets of 6.3 for `a`, computed on its view over `tree` (the head before the change). */
export function setsOf(a: Attempt, tree: FileMap, languages: LanguageSet = TIDEPOOL_LANGUAGES): Sets {
  const v = view(a, tree, languages);
  const A = an(v, languages);
  const Hd = an(tree, languages);
  const added: string[] = [];
  const altered: string[] = [];
  const removed: string[] = [];
  const paths = new Set(curOps(a).map((o) => o.path));
  for (const p of paths) {
    const hk = entityKeysOf(tree, p, languages) ?? [];
    const vk = entityKeysOf(v, p, languages) ?? [];
    for (const k of vk) {
      const eb = hk.includes(k) ? entityAt(tree, k, languages) : null;
      const ev = entityAt(v, k, languages);
      if (eb === null) added.push(k);
      else if (ev !== null && ev.hash !== eb.hash) altered.push(k);
    }
    for (const k of hk) if (!vk.includes(k)) removed.push(k);
  }
  const Altered = [...altered, ...removed];
  const newRefs = new Set<string>();
  const moduleRefs = new Set<string>();
  const addedRefs = new Set<string>();
  const negatives = new Set<string>();
  for (const k of [...added, ...altered]) {
    for (const r of A.refs.get(k) ?? []) if (!added.includes(r)) newRefs.add(r);
    for (const n of A.negatives.get(k) ?? []) {
      newRefs.add(n);
      negatives.add(n);
    }
  }
  for (const k of added) {
    for (const r of A.refs.get(k) ?? []) if (!added.includes(r)) addedRefs.add(r);
  }
  for (const k of altered) {
    const before = Hd.refs.get(k) ?? new Set<string>();
    for (const r of A.refs.get(k) ?? []) {
      if (!added.includes(r) && !before.has(r)) addedRefs.add(r);
    }
  }
  for (const p of paths) {
    for (const k of entityKeysOf(v, p, languages) ?? []) {
      for (const r of A.refs.get(k) ?? []) {
        if (!added.includes(r) && !newRefs.has(r)) moduleRefs.add(r);
      }
      for (const n of A.negatives.get(k) ?? []) {
        if (!newRefs.has(n)) moduleRefs.add(n);
        negatives.add(n);
      }
    }
  }
  const edited = new Set(Altered);
  for (const p of a.premises.values()) if (p.edit) edited.add(p.key);
  return {
    languages,
    view: v,
    Added: added,
    Altered,
    NewRefs: newRefs,
    ModuleRefs: moduleRefs,
    AddedRefs: addedRefs,
    Negatives: negatives,
    Edited: edited,
    A,
    Hd,
    paths,
  };
}

/** Every string literal of the attempt's added and altered entities (row L2). */
export function literalNames(a: Attempt, s: Sets): Set<string> {
  const names = new Set<string>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as { type?: string; value?: unknown; cooked?: unknown };
    if (node.type === "Literal" && typeof node.value === "string") names.add(node.value);
    if (node.type === "TemplateElement") {
      const cooked = (node as { value?: { cooked?: unknown } }).value?.cooked;
      if (typeof cooked === "string") names.add(cooked);
    }
    for (const k of Object.keys(node)) {
      if (k !== "type") walk(node[k as keyof typeof node]);
    }
  };
  for (const k of [...s.Added, ...s.Altered]) {
    const e = entityAt(s.view, k, s.languages);
    if (e) e.nodes.forEach(walk);
  }
  return names;
}

/**
 * The attempt is "sweeping" `dir` (7.2): it has current operations on at least `min(2, n)`
 * distinct paths directly in `dir` that existed in `tree`, where `n` is the file count directly in
 * `dir` in `tree`.
 */
export function sweeping(a: Attempt, dir: string, tree: FileMap): boolean {
  const n = listingOf(tree, dir).filter((x) => !x.endsWith("/")).length;
  if (n === 0) return false;
  const touched = new Set(
    curOps(a)
      .filter((o) => dirOf(o.path) === dir && tree.has(o.path))
      .map((o) => o.path),
  );
  return touched.size >= Math.min(2, n);
}

/** The paths the attempt created (current operations on paths absent from `tree`). */
export function created(a: Attempt, tree: FileMap): Set<string> {
  return new Set(
    curOps(a)
      .filter((o) => !tree.has(o.path))
      .map((o) => o.path),
  );
}

export { occurrences, replay };
