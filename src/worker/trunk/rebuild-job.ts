// The resumable rebuild job of 01-core 3.6 (RB0-RB5, plan 2.4 item 3). Driven by the `rebuild`
// timer: the owner's `rebuild` entry parks a cursor in `meta`, and every alarm run reads it,
// spends at most REBUILD_CALLS_PER_RUN Artifacts calls, and commits the fetched rows plus the
// cursor through the `rebuild_step` engine entry — so a restart resumes exactly where the last
// commit left off (RB3). Every remote read happens outside a transaction (AL4, SY2): the shell
// gathers, the engine writes.
//
// Stages (the cursor's `stage`): `await` waits for the ref read and the Floor's epoch, `walk`
// pages `log` back to the root, `notes` reads the notes tree's fan-out (S1c: by object id),
// `landings` builds each commit's row — from its note when one exists, else from the tree diff
// (`diff` is the resumable sub-cursor of one such walk) — `trees` walks the head tree, `blobs`
// reads the contents the rebuilt tables need, and `finish` is the last apply: heads, indexes,
// `register_expect`, `ready`.

import { PUSH_BACKOFF_BASE_MS, REBUILD_CALLS_PER_RUN, UNDO_WINDOW } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { metaGet, sqlOf, timerPut } from "./sql.ts";
import { outboxRow, type PushDeps } from "./push.ts";
import { recordTrunkError } from "./after-commit.ts";
import { artifactsTokenSource } from "../adapters/token-source/token-source.ts";
import { receivePackPusher } from "../adapters/pusher/pusher.ts";
import type { ArtifactsRepoLike } from "../adapters/token-source/token-source.ts";
import { poolRepoName } from "../repos.ts";
import type {
  ApplyPayload,
  ExpectedRegister,
  LandingPlan,
  RebuildCursor,
  RemoteCommit,
} from "../../core/rebuild/plan.ts";
import {
  landingFromDiff,
  landingFromNote,
  opBlobRefs,
  parseCommitMessage,
  parseNote,
} from "../../core/rebuild/plan.ts";
import { MAX_FILE_BYTES } from "../../protocol/constants.ts";

const MAIN_REF = "refs/heads/main";
const NOTES_REF = "refs/notes/premise";
const GREEN_REF = "refs/heads/green";

/** The repo handle's slice the job reads — `ArtifactsRepo` at runtime, the harness's fake in
 * tests. */
export type RebuildRepo = ArtifactsRepoLike & {
  readCommit(hash: string): Promise<{
    hash: string;
    treeHash: string;
    message: string;
    author: { name: string; email: string };
    committer: { name: string; email: string };
    parents: string[];
    committedAt: number;
  } | null>;
  readTree(hash: string): Promise<{ name: string; type: string; mode: string; hash: string }[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<
    Array<{
      hash: string;
      treeHash: string;
      message: string;
      author: { name: string; email: string };
      parents: string[];
      committedAt: number;
    }>
  >;
};

/** The Floor's read the job needs for RB5: the pool's last snapshot fields. `replay.ndjson` is
 * the Floor's own export (12.3) — the last `pool.state` line carries the epoch and the pool's
 * creation flags. */
export type FloorState = {
  epoch: number;
  summary_only?: boolean;
  synthetic?: boolean;
  remote?: string;
  plain_remote?: string;
};

export type RebuildDeps = PushDeps & {
  /** `env.POOLS` at runtime. */
  pools: { get(name: string): Promise<RebuildRepo> };
  /** Reads the Floor's snapshot for the pool (RB5). */
  floorState(pool: string): Promise<FloorState | null>;
};

function defaultDeps(env: Env): RebuildDeps {
  const floorNs = env.FLOOR;
  return {
    tokenSource: artifactsTokenSource(env.POOLS),
    pusher: receivePackPusher(),
    pools: env.POOLS as unknown as RebuildDeps["pools"],
    async floorState(pool) {
      const id = floorNs.idFromName(pool);
      const response = await floorNs.get(id).fetch(`http://floor/api/pools/${pool}/replay.ndjson`);
      if (!response.ok) return null; // 404: the Floor has never heard of the pool — epoch 0
      const text = await response.text();
      let state: FloorState | null = null;
      for (const line of text.trim().split("\n").slice(1)) {
        try {
          const ev = JSON.parse(line) as { type?: string; epoch?: number };
          if (ev.type === "pool.state" && typeof ev.epoch === "number") {
            state = ev as unknown as FloorState;
          }
        } catch {
          /* a line that is not JSON is skipped */
        }
      }
      return state;
    },
  };
}

/** The durable cursor, read off `meta`. */
function cursorOf(sql: ReturnType<typeof sqlOf>): RebuildCursor | null {
  const raw = metaGet(sql, "rebuild_cursor");
  if (raw === null || raw === "") return null;
  try {
    const c = JSON.parse(raw) as RebuildCursor;
    return c.v === 1 && typeof c.request_id === "string" ? c : null;
  } catch {
    return null;
  }
}

class BudgetExceeded extends Error {}

export type RebuildApply = (name: "rebuild_begin" | "rebuild_step", input: unknown) => Promise<unknown>;

/** A throw of this marks a transport fault: the row stays due and the alarm retries (AL2). */
async function runInner(
  env: Env,
  ctx: DurableObjectState,
  apply: RebuildApply,
  deps: RebuildDeps,
  now: number,
): Promise<void> {
  const sql = sqlOf(ctx);
  let cursor = cursorOf(sql);
  if (cursor === null) return;
  // RB1: a pending outbox reconciles first — the push timer owns that work; wait a beat.
  if (outboxRow(ctx) !== null) {
    timerPut(sql, "rebuild", "", now + PUSH_BACKOFF_BASE_MS);
    return;
  }
  const pool = ctx.id.name ?? "";
  const repoName = poolRepoName(pool);

  // ---- stage `await`: resolve the Floor's epoch (RB5) and the remote refs, then the wipe. ----
  if (cursor.stage === "await") {
    const floor = await deps.floorState(pool);
    const target = await deps.tokenSource.writeTarget(pool);
    const refs = await deps.pusher.readRefs({
      remote: target.remote,
      token: target.token,
      refs: [MAIN_REF, NOTES_REF, GREEN_REF],
      signal: AbortSignal.timeout(30_000),
    });
    if (refs[MAIN_REF] === undefined || refs[MAIN_REF] === null) {
      // The repository answers but has no `main` — a repo created and never seeded, or a name
      // that is no pool at all. There is nothing to rebuild: the arm is released (a wiped store
      // re-arms on the next probe; a live pool keeps its pause for the owner). When the Floor
      // knows this pool the loss is real and gets its `trunk.error` mark (SE5b).
      sql.transaction(() => {
        sql.exec("DELETE FROM meta WHERE k = 'rebuild_cursor'");
        sql.exec("DELETE FROM timers WHERE kind = 'rebuild' AND key = ''");
      });
      if (floor !== null) recordTrunkError(ctx, "rebuild", "remote_empty");
      return;
    }
    const begin = (await apply("rebuild_begin", {
      epoch: (floor?.epoch ?? 0) + 1,
      pool_id: pool,
      remote: floor?.remote ?? target.remote,
      plain_remote: floor?.plain_remote,
      summary_only: floor?.summary_only,
      synthetic: floor?.synthetic,
      head_commit: refs[MAIN_REF] ?? "",
      notes_commit: refs[NOTES_REF] ?? null,
      green_commit: refs[GREEN_REF] ?? null,
      repo: repoName,
    })) as { ok: boolean; error?: { code: string }; cursor?: RebuildCursor };
    if (!begin.ok) {
      if (begin.error?.code === "busy") {
        // The outbox filled meanwhile: wait for the reconcile, then resume (RB1).
        timerPut(sql, "rebuild", "", now + PUSH_BACKOFF_BASE_MS);
        return;
      }
      throw new Error(`rebuild_begin: ${begin.error?.code ?? "failed"}`);
    }
    cursor = begin.cursor!;
  }

  const repo = await deps.pools.get(cursor.repo ?? repoName);
  let calls = 0;
  /** One counted Artifacts read — the run's share of REBUILD_CALLS_PER_RUN (RB3). */
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    if (calls >= REBUILD_CALLS_PER_RUN) throw new BudgetExceeded();
    calls += 1;
    return f();
  };

  // The rows this run's step commits, across whichever stage boundaries it crosses.
  const pending: ApplyPayload = { cursor, landings: [], trees: [], files: [], blobs: [], undone: [] };
  const flush = async (): Promise<void> => {
    cursor.done = (cursor.done ?? 0) + calls;
    pending.cursor = cursor;
    pending.request_id = cursor.request_id;
    await apply("rebuild_step", pending);
    pending.landings = [];
    pending.trees = [];
    pending.files = [];
    pending.blobs = [];
    pending.undone = [];
  };

  try {
    for (;;) {
      // ---- walk: page `log` back to the root; `commits` ends oldest-first, index = seq. ----
      if (cursor.stage === "walk") {
        const head = cursor.head_commit ?? "";
        if (head === "") {
          cursor.commits = [];
          cursor.stage = "notes";
          continue;
        }
        const limit = Math.min(100, Math.max(1, REBUILD_CALLS_PER_RUN - calls));
        const page = await call(() => repo.log({ ref: head, limit, offset: cursor.offset ?? 0 }));
        if (page.length === 0 && (cursor.walked?.length ?? 0) === 0) throw new Error("rebuild: remote main empty");
        cursor.walked = [...(cursor.walked ?? []), ...page.map(remoteCommit)];
        cursor.offset = (cursor.offset ?? 0) + page.length;
        const last = page[page.length - 1];
        if (page.length < limit || (last !== undefined && last.parents.length === 0)) {
          cursor.commits = [...(cursor.walked ?? [])].reverse();
          cursor.walked = undefined;
          cursor.stage = "notes";
          cursor.total = cursor.commits.length;
        }
        continue;
      }

      // ---- notes: the fan-out map commit→note-blob, read by object id (S1c). ----
      if (cursor.stage === "notes") {
        if (cursor.notes_commit === null || cursor.notes_commit === undefined || cursor.notes_commit === "") {
          cursor.notes_map = {};
          cursor.stage = "landings";
          cursor.seq = 1;
          continue;
        }
        if (cursor.notes_root === undefined) {
          const head = await call(() => repo.readCommit(cursor.notes_commit as string));
          if (head === null) {
            cursor.notes_map = {};
            cursor.stage = "landings";
            cursor.seq = 1;
            continue;
          }
          cursor.notes_root = head.treeHash;
          // The queue walks tree dirs by path prefix: Trunk writes notes in two-level fanout
          // (`f3/aa83…`) while a `git notes` rewrite can flatten them to `f3aa83…` at the root —
          // only the joined 40-hex name decides, never the depth.
          cursor.dirs = [["", head.treeHash]];
          cursor.notes_map = {};
        }
        const next = cursor.dirs?.shift();
        if (next === undefined) {
          cursor.stage = "landings";
          cursor.seq = 1;
          cursor.unwitnessed = [];
          cursor.undone = [];
          cursor.blob_map = {};
          continue;
        }
        const entries = await call(() => repo.readTree(next[1]));
        for (const e of entries ?? []) {
          const full = `${next[0]}${e.name}`;
          if (e.type === "blob" && /^[0-9a-f]{40}$/.test(full)) {
            cursor.notes_map![full] = e.hash;
          } else if (e.type === "tree" && /^[0-9a-f]{1,40}$/.test(e.name)) {
            cursor.dirs!.push([full, e.hash]);
          }
        }
        continue;
      }

      // ---- landings: one plan per commit, the note's when it exists else the tree diff. ----
      if (cursor.stage === "landings") {
        const commits: RemoteCommit[] = cursor.commits ?? [];
        const headSeq = commits.length - 1;
        const seq = cursor.seq ?? 1;
        if (seq > headSeq) {
          cursor.stage = "trees";
          const headTree = commits[headSeq]?.treeHash;
          cursor.tree_q = headTree === undefined ? [] : [["", headTree]];
          cursor.head_files = {};
          continue;
        }
        const c = commits[seq]!;
        const noteOid = cursor.notes_map?.[c.hash];
        const inWindow = seq > headSeq - UNDO_WINDOW;
        if (noteOid !== undefined) {
          const blob = await call(() => repo.readBlob(noteOid));
          const note = blob === null ? null : parseNote(await blob.text());
          // Step 2: a note's `seq` must equal the commit's position.
          if (note === null || note.seq !== seq) {
            await apply("rebuild_step", { request_id: cursor.request_id, cursor: null, pause: "note_seq_mismatch" });
            return;
          }
          const texts = new Map<string, string>();
          if (inWindow) {
            for (const oid of opBlobRefs(note)) {
              const b = await call(() => repo.readBlob(oid));
              texts.set(oid, b === null ? "" : await b.text());
            }
          }
          const plan = landingFromNote(c, seq, note, noteOid, inWindow, (oid) => texts.get(oid) ?? null);
          queuePlan(cursor, pending, plan, seq, note.undo?.undoes ?? null);
        } else {
          // Unwitnessed (S1c, step 4): no note — the landing's rows come from the tree diff,
          // itself resumable through `cursor.diff` (a big tree does not fit one run).
          if (cursor.diff === undefined || cursor.diff === null || cursor.diff.seq !== seq) {
            cursor.diff = {
              seq,
              phase: "parent",
              queue: [["", commits[seq - 1]!.treeHash]],
              files: {},
            };
          }
          const d = cursor.diff;
          const which = d.phase === "parent" ? commits[seq - 1]! : c;
          const next = d.queue.shift();
          if (next !== undefined) {
            const entries = await call(() => repo.readTree(next[1]));
            for (const e of entries ?? []) {
              const path = next[0] === "" ? e.name : `${next[0]}/${e.name}`;
              if (e.type === "tree") d.queue.push([path, e.hash]);
              else d.files[path] = [e.hash, e.mode];
            }
            continue;
          }
          if (d.phase === "parent") {
            d.parent_files = d.files;
            d.files = {};
            d.phase = "child";
            d.queue = [["", c.treeHash]];
            continue;
          }
          const plan = landingFromDiff(c, seq, d.parent_files ?? {}, d.files);
          cursor.diff = null;
          (cursor.unwitnessed ??= []).push(seq);
          const { undoes } = parseCommitMessage(c.message);
          const byOid = new Map<string, number>(commits.map((x: RemoteCommit, i: number) => [x.hash, i]));
          for (const undone of undoes) {
            const target = byOid.get(undone);
            if (target !== undefined) (cursor.undone ??= []).push({ seq: target, undone_by: seq });
          }
          for (const f of plan.files) {
            if (f.old_oid !== "absent") cursor.blob_map![f.old_oid] ??= { seq };
          }
          pending.landings!.push(plan);
          cursor.seq = seq + 1;
        }
        continue;
      }

      // ---- trees: the head tree's walk — `trees` rows and the head file list. ----
      if (cursor.stage === "trees") {
        const next = cursor.tree_q?.shift();
        if (next === undefined) {
          cursor.stage = "blobs";
          // The blob queue: every head file's content (files.content), plus every landing's
          // `old_oid` content (`fileMapAt` reads those) and every window op blob.
          cursor.blob_q = [];
          for (const [path, [oid, mode]] of Object.entries(cursor.head_files ?? {})) {
            cursor.blob_q.push({ oid, path, mode });
          }
          for (const [oid, ref] of Object.entries(cursor.blob_map as Record<string, { seq: number }>)) {
            cursor.blob_q.push({ oid, seq: ref.seq });
          }
          continue;
        }
        const entries = await call(() => repo.readTree(next[1]));
        pending.trees!.push({ dir: next[0], oid: next[1] });
        for (const e of entries ?? []) {
          const path = next[0] === "" ? e.name : `${next[0]}/${e.name}`;
          if (e.type === "tree") cursor.tree_q!.push([path, e.hash]);
          else cursor.head_files![path] = [e.hash, e.mode];
        }
        continue;
      }

      // ---- blobs: the content reads — head files into `files`, the rest into `blobs`. ----
      if (cursor.stage === "blobs") {
        const next = cursor.blob_q?.shift();
        if (next === undefined) {
          cursor.stage = "finish";
          continue;
        }
        const blob = await call(() => repo.readBlob(next.oid));
        if (next.path !== undefined) {
          const bytes = blob === null ? null : new Uint8Array(await blob.arrayBuffer());
          const fits = bytes !== null && bytes.byteLength <= MAX_FILE_BYTES;
          pending.files!.push({
            path: next.path,
            oid: next.oid,
            mode: next.mode ?? "100644",
            content: fits ? new TextDecoder().decode(bytes) : null,
          });
        } else {
          const text = blob === null ? "" : await blob.text();
          pending.blobs!.push({ oid: next.oid, content: text, seq: next.seq ?? 0 });
        }
        continue;
      }

      // ---- finish: heads, indexes, `register_expect`, `ready` — the last apply. ----
      if (cursor.stage === "finish") {
        const commits: RemoteCommit[] = cursor.commits ?? [];
        const headSeq = Math.max(0, commits.length - 1);
        const head = commits[headSeq];
        const greenSeq = commits.findIndex((c) => c.hash === cursor.green_commit);
        // `max_batch` rides the cursor, so a job whose landings spanned runs keeps the high mark.
        let maxBatch = cursor.max_batch ?? 0;
        for (const l of pending.landings ?? []) maxBatch = Math.max(maxBatch, l.landing.batch_id);
        await apply("rebuild_step", {
          request_id: cursor.request_id,
          cursor: null,
          finish: {
            head_seq: headSeq,
            head_commit: head?.hash ?? "",
            head_tree: head?.treeHash ?? "",
            notes_commit: cursor.notes_commit ?? "",
            green_seq: greenSeq < 0 ? 0 : greenSeq,
            green_commit: greenSeq < 0 ? "" : (cursor.green_commit ?? ""),
            next_batch_id: maxBatch + 1,
            unwitnessed: cursor.unwitnessed ?? [],
            expect: cursor.expect ?? [],
          },
          landings: pending.landings,
          trees: pending.trees,
          files: pending.files,
          blobs: pending.blobs,
          undone: cursor.undone ?? [],
        });
        return;
      }
      throw new Error(`rebuild: unknown stage ${String(cursor.stage)}`);
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      await flush();
      return;
    }
    throw e;
  }
}

/** A noted landing's plan into the run payload — plus the bookkeeping the finish needs. */
function queuePlan(
  cursor: RebuildCursor,
  pending: ApplyPayload,
  plan: LandingPlan,
  seq: number,
  undoSeqs: number[] | null,
): void {
  pending.landings!.push(plan);
  for (const f of plan.files) {
    if (f.old_oid !== "absent") (cursor.blob_map ??= {})[f.old_oid] ??= { seq };
  }
  // The note's `undo.undoes` names seqs directly; trailers name commit ids — both end here.
  for (const target of undoSeqs ?? []) {
    (cursor.undone ??= []).push({ seq: target, undone_by: seq });
  }
  cursor.max_batch = Math.max(cursor.max_batch ?? 0, plan.landing.batch_id);
  cursor.seq = seq + 1;
}

/** The binding's `log`/`readCommit` row to the plan module's `RemoteCommit`. */
function remoteCommit(c: {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  committedAt: number;
}): RemoteCommit {
  return {
    hash: c.hash,
    treeHash: c.treeHash,
    message: c.message,
    parents: c.parents,
    committedAt: c.committedAt,
    authorName: c.author.name,
    authorEmail: c.author.email,
  };
}

const running = new Set<DurableObjectState>();

/**
 * One run of the `rebuild` timer's work. Re-entrancy (the step's own after-commit waking the
 * timer's path) answers at once; a transport fault propagates so the alarm backs the row off.
 */
export async function runRebuildJob(
  env: Env,
  ctx: DurableObjectState,
  apply: RebuildApply,
  deps: RebuildDeps = defaultDeps(env),
  now: number = Date.now(),
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  try {
    await runInner(env, ctx, apply, deps, now);
  } finally {
    running.delete(ctx);
  }
}
