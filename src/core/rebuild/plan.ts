// src/core/rebuild/plan.ts — the pure half of "rebuild from Artifacts" (01-core.md 3.6, RB0-RB5).
// Everything here is synchronous and free of I/O: the worker's rebuild job
// (src/worker/trunk/rebuild-job.ts) makes the Artifacts calls and feeds the answers in; the
// engine-side apply (apply.ts) writes the rows this module's shapes describe.
//
// The cursor of RB3 lives in `meta.rebuild_cursor` as this JSON. Every stage boundary is a
// place the job can stop and resume: a run makes at most REBUILD_CALLS_PER_RUN calls, then the
// apply entry commits the rows fetched so far together with the cursor that continues them.

import type { Note } from "../../protocol/note.ts";
import { ABSENT } from "../../protocol/premise.ts";
import { MAX_FILE_BYTES } from "../../protocol/constants.ts";

/** One commit of the remote's first-parent history (Artifacts' `log`/`readCommit` answer). */
export type RemoteCommit = {
  hash: string;
  treeHash: string;
  message: string;
  parents: string[];
  /** Committer unix seconds — a rebuilt landing's `accepted_at`/`pushed_at` derive from it. */
  committedAt: number;
  authorName: string;
  authorEmail: string;
};

/** An in-flight attempt captured before the wipe — what `register` is allowed to re-create. */
export type ExpectedRegister = {
  attempt_id: string;
  intent_id: string;
  change_id: string;
  revision: number;
  state: string;
  agent_kind: "real" | "synthetic";
  model: string | null;
  intent_text: string;
  requester: string;
  opened_seq: number;
};

/**
 * The durable cursor. `commits` are oldest-first (the seed/root is `commits[0]`, landing seq k is
 * `commits[k]`). `diff` is the resumable sub-cursor of an unwitnessed landing's tree walk — a pool
 * whose tree has more directories than one run's call budget resumes inside the walk, not over it.
 */
export type RebuildCursor = {
  v: 1;
  request_id: string;
  stage: "await" | "refs" | "walk" | "notes" | "landings" | "diffs" | "trees" | "blobs" | "finish";
  /** The Artifacts repository name for object reads, resolved at stage `refs`. */
  repo?: string;
  remote?: string;
  head_commit?: string;
  green_commit?: string;
  /** The notes commit's oid — null when the remote has no notes ref (every landing unwitnessed). */
  notes_commit?: string | null;
  // walk
  offset?: number;
  walked?: RemoteCommit[]; // newest-first, reversed into `commits` when the root is reached
  commits?: RemoteCommit[]; // oldest-first, `commits[0]` the seed
  // notes
  notes_root?: string;
  dirs?: Array<[string, string]>; // pending fanout dirs: [name, treeOid]
  notes_map?: Record<string, string>; // commit oid -> note blob oid
  // landings
  seq?: number; // the next landing seq to process (1-based)
  unwitnessed?: number[];
  /** `undone_by` links collected as the job walks — applied by the finishing step. */
  undone?: Array<{ seq: number; undone_by: number }>;
  /** Old-oid blob reads the rebuilt `blobs` rows need (fileMapAt), deduped: oid -> {seq}. */
  blob_map?: Record<string, { seq: number }>;
  /** The largest `batch.id` a parsed note named — the finish's `next_batch_id` base. */
  max_batch?: number;
  // diffs — the resumable tree walk of one unwitnessed commit and its parent
  diff?: {
    seq: number;
    phase: "parent" | "child";
    queue: Array<[string, string]>; // [dir, treeOid]
    files: Record<string, [string, string]>; // path -> [oid, mode] accumulated for the current side
    parent_files?: Record<string, [string, string]>;
  } | null;
  // trees — the head tree's resumable walk
  tree_q?: Array<[string, string]>; // [dir, treeOid]
  head_files?: Record<string, [string, string]>; // path -> [oid, mode]
  // blobs — the pending content reads: head files, window old-blobs, window op blobs
  blob_q?: Array<{ oid: string; path?: string; mode?: string; seq?: number }>;
  // progress for pool.state's `rebuild` field: calls made and the best estimate of the total
  done?: number;
  total?: number;
  // captured before the wipe (step 6/7): the in-flight and accepted attempts that may register
  expect?: ExpectedRegister[];
};

/** The writes one apply call commits: rows plus the cursor that continues (or ends) the job. */
export type ApplyPayload = {
  /** The request that started the job — recorded for idempotent repeats (9.8). */
  request_id?: string;
  cursor: RebuildCursor | null; // null on the finishing apply
  /** The finishing apply's head data (step 5) — required when `cursor` is null. */
  finish?: {
    head_seq: number;
    head_commit: string;
    head_tree: string;
    notes_commit: string;
    green_seq: number;
    green_commit: string;
    next_batch_id: number;
    unwitnessed: number[];
    expect: ExpectedRegister[];
  };
  landings?: LandingPlan[];
  /** `undone_by` links resolved over the whole history (applyUndoes), applied at finish. */
  undone?: Array<{ seq: number; undone_by: number }>;
  files?: Array<{ path: string; oid: string; mode: string; content: string | null }>;
  trees?: Array<{ dir: string; oid: string }>;
  blobs?: Array<{ oid: string; content: string; seq: number }>; // content is utf8 text
  progress?: { done: number; total: number };
  pause?: "note_seq_mismatch";
};

/** The row set one rebuilt landing contributes — plain data, written by apply.ts. */
export type LandingPlan = {
  landing: {
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
    pushed_at: number;
    undone_by: number | null;
  };
  files: Array<{ path: string; old_oid: string; new_oid: string }>;
  /** `landing_writes`/`landing_premises`/`landing_ops` — present only for the UNDO_WINDOW tail. */
  writes: Array<{ kind: "entity" | "file" | "listing"; key: string; old_hash: string; new_hash: string }> | null;
  premises: Array<{
    kind: string;
    key: string;
    hash: string;
    seq: number;
    read: boolean;
    edit: boolean;
    derived: boolean;
  }> | null;
  /** Rebuilt `landing_ops` rows: `body` is the op's JSON (blob refs resolved to content). */
  ops: string[] | null;
  intent: { intent_id: string; text: string; requester: string; created_at: number } | null;
  attempt: {
    attempt_id: string;
    intent_id: string;
    change_id: string;
    agent_kind: "real" | "synthetic";
    model: string | null;
    opened_seq: number;
    submitted_at: number | null;
    accepted_at: number;
    landed_seq: number;
    go_arounds: number;
    pull_backs: number;
    revision: number;
    next_hn: number;
    tier: "auto" | "held" | null;
    approved_by: string | null;
    approved_at: number | null;
    approved_option: "land" | "land_now" | "choose" | null;
    policy_risk: unknown;
    summary: string | null;
    attempt_repo: string | null;
    model_calls: number;
    tokens_in: number;
    tokens_out: number;
    steps: number;
  } | null;
};

/** The trailers and fields a landing commit message carries (3.5, CM4). */
export function parseCommitMessage(message: string): {
  changeId: string | null;
  intentId: string | null;
  intentText: string;
  undoes: string[];
} {
  let changeId: string | null = null;
  let intentId: string | null = null;
  let intentText = "";
  const undoes: string[] = [];
  for (const line of message.split("\n")) {
    if (line.startsWith("Change-Id: ")) changeId = line.slice(11).trim();
    else if (line.startsWith("Intent-Id: ")) intentId = line.slice(11).trim();
    else if (line.startsWith("Undoes: ")) undoes.push(line.slice(8).trim());
    else if (line.startsWith("Intent: ")) intentText = line.slice(8).trim();
  }
  return { changeId, intentId, intentText, undoes };
}

/** Parse a note blob: JSON, `v: 1`, integer `seq`, `kind` of the three landing kinds. */
export function parseNote(text: string): Note | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const n = value as Partial<Note>;
  if (n.v !== 1 || typeof n.seq !== "number" || !Number.isInteger(n.seq)) return null;
  if (n.kind !== "change" && n.kind !== "undo" && n.kind !== "revert") return null;
  return n as Note;
}

const isoMs = (iso: string | undefined | null): number | null => {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * The landing plan of a noted commit (step 4): `landing_files` are the `file` rows of
 * `note.writes` — no tree is compared. `window` keeps the companion rows (writes, premises, ops)
 * for the last UNDO_WINDOW landings only. `opsBlob`/`opText` resolve the note's blob references —
 * the job hands in the bytes it read so this stays pure.
 */
export function landingFromNote(
  commit: RemoteCommit,
  seq: number,
  note: Note,
  noteOid: string,
  window: boolean,
  blobText: (oid: string) => string | null,
): LandingPlan {
  const files: LandingPlan["files"] = [];
  for (const w of note.writes ?? []) {
    if (w.kind !== "file") continue;
    files.push({
      path: w.key,
      old_oid: w.old === ABSENT ? "absent" : w.old,
      new_oid: w.new === ABSENT ? "absent" : w.new,
    });
  }
  const submitted = isoMs(note.timing?.submitted_at);
  const accepted = isoMs(note.timing?.accepted_at) ?? commit.committedAt * 1000;
  const attempt = note.attempt;
  const plan: LandingPlan = {
    landing: {
      seq,
      kind: note.kind,
      change_id: note.change_id ?? `u_${seq}`,
      attempt_id: attempt?.id ?? null,
      intent_id: note.intent?.id ?? null,
      batch_id: note.batch?.id ?? 0,
      commit_oid: commit.hash,
      parent_oid: commit.parents[0] ?? "",
      tree_oid: commit.treeHash,
      note_oid: noteOid,
      note: JSON.stringify(note),
      submitted_at: submitted,
      accepted_at: accepted,
      pushed_at: commit.committedAt * 1000,
      undone_by: null,
    },
    files,
    writes: window
      ? (note.writes ?? []).map((w) => ({ kind: w.kind, key: w.key, old_hash: w.old, new_hash: w.new }))
      : null,
    premises: window
      ? (note.premises ?? []).map((p) => ({
          kind: p.kind,
          key: p.key,
          hash: p.hash,
          seq: p.seq,
          read: p.read,
          edit: p.edit,
          derived: p.derived,
        }))
      : null,
    ops: window
      ? (note.ops ?? []).map((o, i) =>
          JSON.stringify(
            o.op === "write"
              ? "delete" in o && o.delete === true
                ? { op_seq: i + 1, op: "write", path: o.path, content: null, base_oid: "absent", dropped: false }
                : "blob" in o
                  ? {
                      op_seq: i + 1,
                      op: "write",
                      path: o.path,
                      content: blobText(o.blob) ?? "",
                      base_oid: o.blob,
                      dropped: false,
                    }
                  : {
                      op_seq: i + 1,
                      op: "write",
                      path: o.path,
                      content: "content" in o ? o.content : "",
                      base_oid: "absent",
                      dropped: false,
                    }
              : "old_oid" in o
                ? {
                    op_seq: i + 1,
                    op: "replace",
                    path: o.path,
                    old: blobText(o.old_oid) ?? "",
                    new: blobText(o.new_oid) ?? "",
                    targets: o.targets ?? [],
                    dropped: false,
                  }
                : {
                    op_seq: i + 1,
                    op: "replace",
                    path: o.path,
                    old: "old" in o ? o.old : "",
                    new: "new" in o ? o.new : "",
                    targets: o.targets ?? [],
                    dropped: false,
                  },
          ),
        )
      : null,
    intent:
      note.intent === null || note.intent === undefined
        ? null
        : {
            intent_id: note.intent.id,
            text: note.intent.text,
            requester: note.intent.requester,
            created_at: isoMs(note.intent.created_at) ?? accepted,
          },
    attempt:
      attempt === null || attempt === undefined
        ? null
        : {
            attempt_id: attempt.id,
            intent_id: note.intent?.id ?? `i_${attempt.id}`,
            change_id: note.change_id,
            agent_kind: attempt.agent === "synthetic" ? "synthetic" : "real",
            model: attempt.model ?? null,
            opened_seq: attempt.opened_seq ?? 0,
            submitted_at: submitted,
            accepted_at: accepted,
            landed_seq: seq,
            go_arounds: note.go_arounds?.length ?? 0,
            pull_backs: note.pull_backs ?? 0,
            revision: note.revision ?? 1,
            next_hn:
              1 + Math.max(0, ...(note.go_arounds ?? []).map((g) => g.hn), ...(note.confirms ?? []).map((c) => c.hn)),
            tier: note.policy?.tier ?? "auto",
            approved_by: note.policy?.approved_by ?? null,
            approved_at: isoMs(note.policy?.approved_at),
            approved_option: note.policy?.option ?? null,
            policy_risk: note.policy?.risk ?? null,
            summary: note.summary === "" ? null : (note.summary ?? null),
            attempt_repo: attempt.repo ?? null,
            model_calls: attempt.model_calls ?? 0,
            tokens_in: attempt.tokens_in ?? 0,
            tokens_out: attempt.tokens_out ?? 0,
            steps: attempt.steps ?? 0,
          },
  };
  return plan;
}

/**
 * The landing plan of an unwitnessed commit (step 4): empty premises and writes, and the file diff
 * of its tree against its parent's, computed by the job's tree walk. Trailers give it a change id
 * when the commit still carries one (a landing whose note push was lost is recognised as Trunk's).
 */
export function landingFromDiff(
  commit: RemoteCommit,
  seq: number,
  parentFiles: Record<string, [string, string]>,
  childFiles: Record<string, [string, string]>,
): LandingPlan {
  const t = parseCommitMessage(commit.message);
  const files: LandingPlan["files"] = [];
  const paths = new Set([...Object.keys(parentFiles), ...Object.keys(childFiles)]);
  for (const path of [...paths].sort()) {
    const before = parentFiles[path]?.[0];
    const after = childFiles[path]?.[0];
    if (before === after) continue;
    files.push({ path, old_oid: before ?? "absent", new_oid: after ?? "absent" });
  }
  const kind = t.undoes.length > 0 ? "undo" : "change";
  // 3.5: a change landing's author email is `<attempt id>@agents.premise.invalid`, its name the
  // model or `SYNTHETIC swarm`; an undo/revert's author is `Premise Trunk <trunk@premise.invalid>`.
  const authorAttempt = /^(.+)@agents\.premise\.invalid$/.exec(commit.authorEmail)?.[1] ?? null;
  const synthetic = commit.authorName === "SYNTHETIC swarm";
  return {
    landing: {
      seq,
      kind,
      change_id: t.changeId ?? `u_${seq}`,
      attempt_id: authorAttempt,
      intent_id: t.intentId,
      batch_id: 0,
      commit_oid: commit.hash,
      parent_oid: commit.parents[0] ?? "",
      tree_oid: commit.treeHash,
      note_oid: "",
      note: "",
      submitted_at: null,
      accepted_at: commit.committedAt * 1000,
      pushed_at: commit.committedAt * 1000,
      undone_by: null,
    },
    files,
    writes: [],
    premises: [],
    ops: [],
    intent:
      t.intentId === null
        ? null
        : { intent_id: t.intentId, text: t.intentText, requester: "owner", created_at: commit.committedAt * 1000 },
    attempt:
      authorAttempt === null
        ? null
        : {
            attempt_id: authorAttempt,
            intent_id: t.intentId ?? `i_${authorAttempt}`,
            change_id: t.changeId ?? `u_${seq}`,
            agent_kind: synthetic ? "synthetic" : "real",
            model: synthetic ? null : commit.authorName,
            opened_seq: 0,
            submitted_at: null,
            accepted_at: commit.committedAt * 1000,
            landed_seq: seq,
            go_arounds: 0,
            pull_backs: 0,
            revision: 1,
            next_hn: 1,
            tier: null,
            approved_by: null,
            approved_at: null,
            approved_option: null,
            policy_risk: null,
            summary: null,
            attempt_repo: null,
            model_calls: 0,
            tokens_in: 0,
            tokens_out: 0,
            steps: 0,
          },
  };
}

/** The blob oids a window landing's `landing_ops` rebuild must read (`blob`, `old_oid`, `new_oid`). */
export function opBlobRefs(note: Note): string[] {
  const out: string[] = [];
  for (const o of note.ops ?? []) {
    if (o.op === "write" && "blob" in o && typeof o.blob === "string") out.push(o.blob);
    if (o.op === "replace") {
      if ("old_oid" in o && typeof o.old_oid === "string") out.push(o.old_oid);
      if ("new_oid" in o && typeof o.new_oid === "string") out.push(o.new_oid);
    }
  }
  return out;
}

/** True when a blob read answer fits a `files` row: RB4 — oversize content stays NULL. */
export function blobFits(size: number): boolean {
  return size <= MAX_FILE_BYTES;
}

/**
 * The `changed_seq` of every head path: the greatest landing seq whose `landing_files` row names
 * the path, else 0 (the seed's files and anything no landing touched).
 */
export function changedSeqs(landings: readonly LandingPlan[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of landings) {
    for (const f of l.files) {
      const cur = out.get(f.path);
      if (cur === undefined || l.landing.seq > cur) out.set(f.path, l.landing.seq);
    }
  }
  return out;
}

/**
 * The `undone_by` links of a rebuilt history: an undo/revert landing's commit carries
 * `Undoes: <commit>` trailers (CM4); the target's seq comes from the commit order.
 */
export function applyUndoes(commits: readonly RemoteCommit[], plans: readonly LandingPlan[]): void {
  const seqOf = new Map<string, number>();
  for (const p of plans) seqOf.set(p.landing.commit_oid, p.landing.seq);
  for (let i = 0; i < commits.length; i++) {
    const seq = i; // commits[0] is the seed; landing seq k is commits[k]
    if (seq === 0) continue;
    const { undoes } = parseCommitMessage(commits[i]!.message);
    const plan = plans.find((p) => p.landing.seq === seq);
    if (plan === undefined) continue;
    for (const undone of undoes) {
      const target = seqOf.get(undone);
      if (target !== undefined) {
        const targetPlan = plans.find((p) => p.landing.seq === target);
        if (targetPlan !== undefined) targetPlan.landing.undone_by = seq;
      }
    }
  }
}
