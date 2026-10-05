// The resumable import job of 06-repos (IR3, IR4, IR5): the `rebuild` timer's work for a pool
// whose cursor carries `job: "import"`. Same shape as the rebuild (3.6, RB3/RB4): a durable
// cursor in `meta`, at most REBUILD_CALLS_PER_RUN binding calls per alarm run, remote reads
// outside transactions, and every committed slice landed by the `import_step` engine entry —
// so a Worker restart resumes where the last commit stopped.
//
// Stages (the cursor's `stage`):
//   await   — `log` finds the imported head commit (depth 1: the one commit `main` holds).
//   walk    — breadth-first `readTree` over the head tree; every entry counted for IR4, the
//             directories and leaves kept in the cursor. Nothing is stored yet.
//   sizes   — one `readBlob` per blob/exec leaf, for its size: IR4's second count is bytes in
//             blobs of at most MAX_FILE_BYTES. The blob is re-read in `blobs` for content —
//             a leaf over the limit is never read again (RB4: stored opaque).
//   blobs   — the first apply stores the walked directories, then every leaf: unmanaged
//             entries (a symbolic link, a submodule, a path outside 2.1) and oversized blobs
//             land as object-id rows with content NULL; the rest are fetched and stored.
//   finish  — head commit/tree, the guide file (IR9), entities/refs, `ready`, `pool.files`.
//
// IR4's order is hard: the entry count is final at end of `walk`, the byte count at end of
// `sizes`, and not a row is stored before both have passed — a too-large repository pauses
// the pool with nothing half-written.

import { IMPORT_MAX_ENTRIES, IMPORT_MAX_TEXT_BYTES, REBUILD_CALLS_PER_RUN } from "../../protocol/constants.ts";
import { MAX_FILE_BYTES } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { metaGet, sqlOf } from "./sql.ts";
import { isManagedEntry, type ImportCursor, type ImportLeaf, type ImportPayload } from "../../core/trunk/import.ts";
import { poolRepoName } from "../repos.ts";
import type { RebuildRepo } from "./rebuild-job.ts";

/** The guide files of IR9, in their order — the first the imported head tree holds wins. */
const GUIDE_CANDIDATES = ["AGENTS.md", "CONTRIBUTING.md", "README.md"] as const;

/** The durable cursor, read off `meta` — the import's, not the rebuild's (`job` decides). */
function cursorOf(sql: ReturnType<typeof sqlOf>): ImportCursor | null {
  const raw = metaGet(sql, "rebuild_cursor");
  if (raw === null || raw === "") return null;
  try {
    const c = JSON.parse(raw) as ImportCursor;
    return c.v === 1 && c.job === "import" && typeof c.request_id === "string" ? c : null;
  } catch {
    return null;
  }
}

class BudgetExceeded extends Error {}

export type ImportApply = (name: "import_step", input: unknown) => Promise<unknown>;

export type ImportDeps = {
  pools: { get(name: string): Promise<RebuildRepo> };
};

function defaultDeps(env: Env): ImportDeps {
  return { pools: env.POOLS as unknown as ImportDeps["pools"] };
}

async function runInner(env: Env, ctx: DurableObjectState, apply: ImportApply, deps: ImportDeps): Promise<void> {
  const sql = sqlOf(ctx);
  const cursor = cursorOf(sql);
  if (cursor === null) return;

  // ---- await: the imported head — depth 1 means `log`'s first row is the whole history. ----
  if (cursor.stage === "await") {
    const repo = await deps.pools.get(cursor.repo || poolRepoName(ctx.id.name ?? ""));
    const page = await repo.log({ limit: 1 });
    const head = page[0];
    if (head === undefined) throw new Error("import: remote main empty");
    cursor.head_commit = head.hash;
    cursor.head_tree = head.treeHash;
    cursor.tree_q = [["", head.treeHash]];
    cursor.dir_rows = [];
    cursor.leaves = [];
    cursor.entries = 0;
    cursor.text_bytes = 0;
    cursor.stage = "walk";
    await apply("import_step", { request_id: cursor.request_id, cursor });
  }

  const repo = await deps.pools.get(cursor.repo || poolRepoName(ctx.id.name ?? ""));
  let calls = 0;
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    if (calls >= REBUILD_CALLS_PER_RUN) throw new BudgetExceeded();
    calls += 1;
    return f();
  };

  const pending: ImportPayload = { cursor, files: [], trees: [] };
  const flush = async (): Promise<void> => {
    cursor.done = (cursor.done ?? 0) + calls;
    pending.cursor = cursor;
    pending.request_id = cursor.request_id;
    await apply("import_step", pending);
    pending.files = [];
    pending.trees = [];
  };

  try {
    for (;;) {
      // ---- walk: readTree the queue dry; every returned row is an IR4 entry. ----
      if (cursor.stage === "walk") {
        const next = cursor.tree_q?.shift();
        if (next === undefined) {
          if ((cursor.entries ?? 0) > IMPORT_MAX_ENTRIES) {
            await apply("import_step", { request_id: cursor.request_id, cursor: null, pause: "repo_too_large" });
            return;
          }
          // `sizes` reads each blob leaf once for its byte count; links and gitlinks carry no
          // blob Trunk stores, so they never enter the queue (and their bytes stay unread —
          // an unmanaged entry is kept by object id, never fetched).
          cursor.size_q = (cursor.leaves ?? []).filter((l) => l.mode === "100644" || l.mode === "100755");
          cursor.total = (cursor.entries ?? 0) + cursor.size_q.length;
          cursor.stage = "sizes";
          continue;
        }
        const entries = await call(() => repo.readTree(next[1]));
        cursor.entries = (cursor.entries ?? 0) + (entries?.length ?? 0);
        for (const e of entries ?? []) {
          const path = next[0] === "" ? e.name : `${next[0]}/${e.name}`;
          const mode = "mode" in e && typeof e.mode === "string" ? e.mode : e.type === "tree" ? "40000" : "100644";
          if (e.type === "tree") {
            cursor.tree_q!.push([path, e.hash]);
            cursor.dir_rows!.push({ dir: path, oid: e.hash });
          } else {
            cursor.leaves!.push({ path, oid: e.hash, mode });
          }
        }
        continue;
      }

      // ---- sizes: the byte count of IR4 over blobs of at most MAX_FILE_BYTES. ----
      if (cursor.stage === "sizes") {
        const next = cursor.size_q?.shift();
        if (next === undefined) {
          if ((cursor.text_bytes ?? 0) > IMPORT_MAX_TEXT_BYTES) {
            await apply("import_step", { request_id: cursor.request_id, cursor: null, pause: "repo_too_large" });
            return;
          }
          cursor.blob_q = [...(cursor.leaves ?? [])];
          // The directories are the first rows stored — IR4's counts are both final here.
          pending.trees = [...(cursor.dir_rows ?? [])];
          pending.trees!.push({ dir: "", oid: cursor.head_tree ?? "" });
          cursor.stage = "blobs";
          continue;
        }
        const blob = await call(() => repo.readBlob(next.oid));
        const size = blob === null ? 0 : blob.size;
        next.size = size;
        if (size <= MAX_FILE_BYTES) cursor.text_bytes = (cursor.text_bytes ?? 0) + size;
        continue;
      }

      // ---- blobs: the rows — directories first, then every leaf managed or not. ----
      if (cursor.stage === "blobs") {
        const next = cursor.blob_q?.shift();
        if (next === undefined) {
          cursor.stage = "finish";
          continue;
        }
        const managed = isManagedEntry(next.path, next.mode);
        const oversized = next.size !== undefined && next.size > MAX_FILE_BYTES;
        const readable = next.mode === "100644" || next.mode === "100755";
        if (!managed || !readable || oversized) {
          pending.files!.push({ path: next.path, oid: next.oid, mode: next.mode, content: null });
          continue;
        }
        const blob = await call(() => repo.readBlob(next.oid));
        const bytes = blob === null ? null : new Uint8Array(await blob.arrayBuffer());
        const fits = bytes !== null && bytes.byteLength <= MAX_FILE_BYTES;
        pending.files!.push({
          path: next.path,
          oid: next.oid,
          mode: next.mode,
          content: fits ? new TextDecoder().decode(bytes) : null,
        });
        continue;
      }

      // ---- finish: head, guide (IR9), `ready` and `pool.files` — the last apply. ----
      if (cursor.stage === "finish") {
        const paths = new Set((cursor.leaves ?? []).map((l) => l.path));
        const guide = GUIDE_CANDIDATES.find((c) => paths.has(c)) ?? null;
        await apply("import_step", {
          request_id: cursor.request_id,
          cursor: null,
          finish: { head_commit: cursor.head_commit ?? "", head_tree: cursor.head_tree ?? "", guide },
          files: pending.files,
          trees: pending.trees,
        });
        return;
      }
      throw new Error(`import: unknown stage ${String(cursor.stage)}`);
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      await flush();
      return;
    }
    throw e;
  }
}

const running = new Set<DurableObjectState>();

/**
 * One run of the `rebuild` timer's import half (IR3). Same re-entrancy and fault contract as
 * `runRebuildJob`: a transport fault propagates so the alarm backs the row off (AL2).
 */
export async function runImportJob(
  env: Env,
  ctx: DurableObjectState,
  apply: ImportApply,
  deps: ImportDeps = defaultDeps(env),
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  try {
    await runInner(env, ctx, apply, deps);
  } finally {
    running.delete(ctx);
  }
}
