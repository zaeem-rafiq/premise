// src/core/trunk/plain.ts — the engine half of the plain-merge pool (01-core 11.7, PM1-PM7).
// The `plain` timer's entry (3.3) replays the pushed landings with `replayPlainMerge` and parks
// the next commit of `<pool>-plain`'s `main` in `meta.plain_pending`; the worker pushes it and
// `plain_done` applies the answer — `plain_commit`, `plain_remote` and the `plain.updated`
// event. Everything here is synchronous and transaction-bound (SY2, AL4): no remote read, no
// clock but the pool's own.

import { replayPlainMerge, type PlainLanding } from "../plain/plain.ts";
import { makeCommit, type GitObject } from "../git/objects.ts";
import { makeTreeFromFiles } from "../git/tree-files.ts";
import { buildPack } from "../git/pack.ts";
import { emitPoolState, event, metaWrite } from "./events.ts";
import { metaSet } from "./schema.ts";
import type { Landing, Op, Pool } from "./sets.ts";

/** `meta.plain_pending`: the commit spec the runner is pushing (LP6's shape — durable, so a
 * restart retries the same bytes; the pack itself is rebuilt deterministically on each run). */
export type PlainPending = {
  v: 1;
  commit: string;
  tree: string;
  /** What `refs/heads/main` of `<pool>-plain` must still hold for the push; "" for none yet. */
  parent: string;
  /** The commit's timestamp in seconds — frozen so a retry rebuilds the same commit. */
  at: number;
  through_seq: number;
  skipped: number[];
  interrupted: number[];
};

export type PlainBuild = { state: "idle" } | ({ state: "build" } & PlainPending & { pack: Uint8Array });

const PENDING_KEY = "plain_pending";

function pendingOf(pool: Pool): PlainPending | null {
  const raw = pool.meta.get(PENDING_KEY);
  if (raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw) as PlainPending;
  } catch {
    return null;
  }
}

function metaDrop(pool: Pool, key: string): void {
  pool.meta.delete(key);
  metaSet(pool.sql, key, null);
}

/** The landing's revision — the `ops_first` key's other half (PM1: the revision that landed). */
function landingRevision(l: Landing): number {
  try {
    const note = JSON.parse(l.note) as { revision?: unknown };
    return typeof note.revision === "number" ? note.revision : 0;
  } catch {
    return 0;
  }
}

/** PM5: the seqs an `undo`/`revert` landing takes back, read off the `undone_by` marks it left. */
function undoesOf(pool: Pool, l: Landing): number[] {
  return pool.landings
    .filter((x) => x.undone_by === l.seq)
    .map((x) => x.seq)
    .sort((a, b) => a - b);
}

/** One landing as `replayPlainMerge` needs it (PM1): `ops_first` when the attempt's revision
 * has a row, the landed operations otherwise; undo/revert carry the seqs they reverted. */
function plainLandingOf(pool: Pool, l: Landing): PlainLanding {
  if (l.kind === "change") {
    if (l.attempt_id !== null) {
      const row = pool.sql
        .exec(
          "SELECT ops, submitted FROM ops_first WHERE attempt_id = ? AND revision = ?",
          l.attempt_id,
          landingRevision(l),
        )
        .toArray()[0];
      if (row !== undefined) {
        return {
          seq: l.seq,
          kind: "change",
          ops: JSON.parse(String(row.ops)) as Op[],
          opsFirst: true,
          submitted: Number(row.submitted) === 1,
        };
      }
    }
    return { seq: l.seq, kind: "change", ops: l.ops, opsFirst: false, submitted: false };
  }
  return { seq: l.seq, kind: l.kind, ops: [], opsFirst: false, submitted: false, undoes: undoesOf(pool, l) };
}

/** The replay over the seed tree (PM1: "start from the seed" — the head at seq 0). */
function replayThrough(pool: Pool, throughSeq: number) {
  const landings = pool.landings
    .filter((l) => l.pushed_at !== null && l.seq <= throughSeq)
    .sort((a, b) => a.seq - b.seq)
    .map((l) => plainLandingOf(pool, l));
  return replayPlainMerge(pool.fileMapAt(0), landings);
}

/** The deterministic objects a pending spec stands for: replayed files' tree + the commit. */
function materialize(
  pool: Pool,
  pending: Pick<PlainPending, "through_seq" | "parent" | "at">,
): {
  tree: GitObject;
  commit: GitObject;
  objects: GitObject[];
  skipped: number[];
  interrupted: number[];
} {
  const merge = replayThrough(pool, pending.through_seq);
  const filesForTree: Record<string, string> = {};
  for (const [p, c] of merge.files) filesForTree[p] = c;
  const { root, objects } = makeTreeFromFiles(filesForTree);
  const ident = { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: pending.at };
  const commit = makeCommit({
    tree: root.oid,
    parents: pending.parent === "" ? [] : [pending.parent],
    author: ident,
    committer: ident,
    message: `Premise plain-merge through seq ${pending.through_seq}`,
  });
  return {
    tree: root,
    commit,
    objects: [commit, ...objects],
    skipped: [...merge.skipped],
    interrupted: [...merge.interrupted],
  };
}

/** `plain` (11.7): park or reproduce the next plain-merge commit and hand the runner its bytes.
 * `parent_override` re-anchors the pending commit when the remote's `main` moved underneath —
 * the same tree, same timestamp, a new parent and so a new commit id (the remote's own value is
 * the parent, so the push that follows is a fast-forward it cannot refuse). */
/** Whether the pool has a plain-merge pool at all (11.7): an imported pool (IR7, `app` "") and a
 * summary-only pool (EV6, the Swarm's) have none, so the `plain` timer is never armed for them. */
export function buildsPlain(pool: { meta: { get(key: string): string | undefined } }): boolean {
  return pool.meta.get("app") !== "" && pool.meta.get("summary_only") !== "1";
}

export function plainBuild(pool: Pool, input: { parent_override?: string } = {}): PlainBuild {
  // A rebuilding pool's landings are mid-flight; the job's own finish re-arms nothing here —
  // the next `batch.pushed` does, and the remote repository was left consistent as it stood.
  if (pool.meta.get("pool_state") === "rebuilding") return { state: "idle" };
  let pending = pendingOf(pool);
  if (pending === null) {
    const pushed = pool.landings.filter((l) => l.pushed_at !== null);
    const through = pushed.length === 0 ? 0 : pushed[pushed.length - 1]!.seq;
    const stored = Number(pool.meta.get("plain_through_seq") ?? "0");
    const haveCommit = (pool.meta.get("plain_commit") ?? "") !== "";
    // Idle only when the remote already shows a commit covering every pushed landing. A pool
    // with no `plain_commit` yet always builds — the first commit is the seed's baseline. A
    // `parent_override` (the runner found the remote's `main` moved) always builds.
    if (through === stored && haveCommit && input.parent_override === undefined) return { state: "idle" };
    const at = Math.floor(pool.now() / 1000);
    const parent = input.parent_override ?? (haveCommit ? (pool.meta.get("plain_commit") ?? "") : "");
    const built = materialize(pool, { through_seq: through, parent, at });
    pending = {
      v: 1,
      commit: built.commit.oid,
      tree: built.tree.oid,
      parent,
      at,
      through_seq: through,
      skipped: built.skipped,
      interrupted: built.interrupted,
    };
    metaWrite(pool, PENDING_KEY, JSON.stringify(pending));
  } else if (input.parent_override !== undefined && input.parent_override !== pending.parent) {
    const built = materialize(pool, { ...pending, parent: input.parent_override });
    pending = { ...pending, parent: input.parent_override, commit: built.commit.oid, tree: built.tree.oid };
    metaWrite(pool, PENDING_KEY, JSON.stringify(pending));
  }
  const { objects } = materialize(pool, pending);
  return { state: "build", ...pending, pack: buildPack(objects) };
}

/** `plain_done` (PM6): the pushed commit is `main` of `<pool>-plain` — record it, tell the
 * stream (`plain.updated`, and `pool.state` when `plain_remote` first arrives, EM1), and re-arm
 * the timer while pushed landings the build did not cover remain. */
export function plainDone(pool: Pool, input: { commit: string; remote: string }): Record<string, unknown> {
  const pending = pendingOf(pool);
  // LP6's compare-and-swap: a done twice, or one whose pending was superseded, changes nothing.
  if (pending === null || pending.commit !== input.commit) return { ok: false, error: { code: "stale" } };
  metaWrite(pool, "plain_commit", pending.commit);
  metaWrite(pool, "plain_through_seq", pending.through_seq);
  metaDrop(pool, PENDING_KEY);
  const remoteMoved = (pool.meta.get("plain_remote") ?? "") !== input.remote;
  if (input.remote !== "") metaWrite(pool, "plain_remote", input.remote);
  event(pool, "plain.updated", {
    commit: pending.commit,
    tree: pending.tree,
    through_seq: pending.through_seq,
    skipped: pending.skipped,
    interrupted: pending.interrupted,
  });
  if (remoteMoved) emitPoolState(pool);
  const more = pool.landings.some((l) => l.pushed_at !== null && l.seq > pending.through_seq);
  if (more) pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('plain', '', ?)", pool.now());
  return { ok: true };
}
