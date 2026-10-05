// The import job's core half (06-repos IR3, IR4, IR5, IR6): a slice of the whole imported tree is
// applied to a pool whose `pool_state` is `rebuilding` with `pause_reason` `import` — the same
// carve-out the rebuild uses (3.6), so every guard that stops a pool mid-rebuild stops an import
// the same way, and every step lands in the storage-begin transaction next to its cursor so the
// job survives a Worker restart (RB4).
//
// The worker side (`src/worker/trunk/import-job.ts`) does every remote read; this file only takes
// what a slice read and writes it. IR4's counting happens entirely in the cursor — rows land only
// after the count has passed, so a pool that turns out too large has nothing half-stored.
import { an } from "./sets.ts";
import { emitPoolFiles, emitPoolState, metaWrite } from "./events.ts";
import type { Pool } from "./sets.ts";
import { isPath } from "../keys/paths.ts";
import { utf8 } from "../sync/bytes.ts";
import { MAX_FILE_BYTES } from "../../protocol/constants.ts";

// The meta key the job's cursor lives under — the rebuild's key, since a pool is never in both
// jobs at once and "the job is running" is one fact.
export const IMPORT_CURSOR_KEY = "rebuild_cursor";

/** A leaf of the imported tree as the job records it: path, Git mode, object id, optional size. */
export type ImportLeaf = { path: string; oid: string; mode: string; size?: number };

/**
 * The import cursor — same fields as the rebuild's where the jobs agree, plus the accumulation
 * the IR4 count needs before a single row is stored. `repo` and `branch` are the pool's
 * Artifacts repository name and the imported source's branch ("" when the default branch was
 * taken).
 */
export type ImportCursor = {
  v: 1;
  /** Marks the cursor as the import job's: the `rebuild` timer reads it and dispatches —
   * the rebuild's own cursor has no `job` field. `rebuild_cursor` is shared so the
   * `pool.state.rebuild` progress fields read the running job without a branch. */
  job: "import";
  request_id: string;
  stage: "await" | "walk" | "sizes" | "blobs" | "finish";
  repo: string;
  branch: string;
  head_commit?: string;
  head_tree?: string;
  // `tree_q` holds `[dir, treeOid]` pairs still to expand. `dir_rows` and `leaves` accumulate the
  // walk's result in the cursor — nothing reaches `files`/`trees` until IR4's count has passed.
  tree_q?: Array<[dir: string, oid: string]>;
  dir_rows?: Array<{ dir: string; oid: string }>;
  leaves?: ImportLeaf[];
  entries?: number;
  text_bytes?: number;
  // `sizes` = leaves of `type: "blob"` still needing a size read; `blobs` = leaves whose blob
  // content is still to fetch. `done`/`total` drive the rebuilt progress fields (3.6).
  size_q?: ImportLeaf[];
  blob_q?: ImportLeaf[];
  done?: number;
  total?: number;
};

/** What one alarm run's remote reads produced — the pure `applyImportStep` consumes this. */
export type ImportPayload = {
  request_id?: string;
  cursor: ImportCursor | null;
  // Entries the run read, applied idempotently: a blob over MAX_FILE_BYTES or any unmanaged leaf
  // arrives with `content: null` and is stored as an object-id row (IR5, RB4).
  files?: Array<{ path: string; oid: string; mode: string; content: string | null }>;
  trees?: Array<{ dir: string; oid: string }>;
  pause?: "repo_too_large";
  finish?: { head_commit: string; head_tree: string; guide: string | null };
};

/**
 * A managed leaf: the path matches the modules grammar (2.1) and the mode is an ordinary file.
 * Step 1 makes every such file a module candidate only when it is `.js`/`.mjs` — everything else
 * is file-level (opaque to the engine, but listed/readable up to MAX_FILE_BYTES).
 */
export function isManagedEntry(path: string, mode: string): boolean {
  return isPath(path) && (mode === "100644" || mode === "100755");
}

export type ImportResult =
  { ok: true; done: boolean; paused?: "repo_too_large" } | { ok: false; error: { code: string; message?: string } };

export function readImportCursor(pool: Pool): ImportCursor | null {
  const raw = pool.meta.get(IMPORT_CURSOR_KEY);
  if (raw === undefined || raw === "") return null;
  return JSON.parse(raw) as ImportCursor;
}

/**
 * Apply one import slice. Emits `pool.state` after every cursor move; the `rebuilt` progress
 * fields land on the same event the cursor does (3.6). Only callable while the pool is in the
 * `rebuilding`/`import` state — the worker checks that itself and answers `not_importing`.
 */
export function applyImportStep(pool: Pool, payload: ImportPayload): ImportResult {
  const sql = pool.sql;
  const importing = pool.meta.get("pool_state") === "rebuilding" && pool.meta.get("pause_reason") === "import";
  if (!importing) return { ok: false, error: { code: "not_importing", message: "pool is not importing" } };

  // IR4: the tree over either limit pauses the pool; nothing was stored, so nothing is wiped.
  if (payload.pause === "repo_too_large") {
    metaWrite(pool, IMPORT_CURSOR_KEY, null);
    metaWrite(pool, "pool_state", "paused");
    metaWrite(pool, "pause_reason", "repo_too_large");
    emitPoolState(pool);
    return { ok: true, done: false, paused: "repo_too_large" };
  }

  for (const t of payload.trees ?? []) {
    sql.exec("INSERT OR REPLACE INTO trees (dir, oid) VALUES (?, ?)", t.dir, t.oid);
    pool.trees.set(t.dir, t.oid);
  }
  const headEntries = pool.entries; // local: the seam guard reads `pool.entries`' writes as table writes
  for (const f of payload.files ?? []) {
    const managed = isManagedEntry(f.path, f.mode);
    sql.exec(
      "INSERT OR REPLACE INTO files (path, mode, oid, content, parse_state, changed_seq) VALUES (?, ?, ?, ?, ?, 0)",
      f.path,
      f.mode,
      f.oid,
      f.content === null ? null : utf8(f.content),
      managed ? "ok" : "unmanaged",
    );
    headEntries.set(f.path, { oid: f.oid, mode: f.mode });
    pool.modes.set(f.path, f.mode);
    // `pool.files` stays the managed view (IR5): an unmanaged leaf never enters it; an oversized
    // managed blob sits there as "" so OP5/`read` see a present file, with `pool.opaque` naming it.
    if (managed) {
      pool.files.set(f.path, f.content ?? "");
      if (f.content === null) pool.opaque.add(f.path);
      else pool.opaque.delete(f.path);
    }
  }

  if (payload.cursor != null) {
    const c = payload.cursor;
    metaWrite(pool, IMPORT_CURSOR_KEY, JSON.stringify(c));
    emitPoolState(pool);
    // The job continues through the alarm's claim rule: a `rebuild` timer row names the next run.
    sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild', '', ?)", pool.now());
    return { ok: true, done: false };
  }

  const fin = payload.finish;
  if (fin === undefined)
    return { ok: false, error: { code: "invalid_args", message: "import slice without cursor or finish" } };

  // The imported head commit is the seed commit (IR2): head_seq and landed_seq stay 0 and nothing
  // is pushed for it — `landed_commit` only names the tree landings diff from.
  metaWrite(pool, "head_commit", fin.head_commit);
  metaWrite(pool, "head_tree", fin.head_tree);
  metaWrite(pool, "landed_commit", fin.head_commit);
  // IR9: the first of AGENTS.md, CONTRIBUTING.md, README.md the tree holds — the prompt task
  // reads `guide_path` and omits the guide sentence when it is "".
  metaWrite(pool, "guide_path", fin.guide ?? "");

  // Entities and refs of the imported modules — the same analysis the rebuild finish runs.
  const analysis = an(pool.files);
  sql.exec("DELETE FROM entities");
  sql.exec("DELETE FROM refs");
  for (const [path, info] of analysis.modules) {
    for (const e of info.entities) {
      sql.exec(
        "INSERT OR REPLACE INTO entities (key, path, name, kind, exports, arity, hash, changed_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        `${path}#${e.name}`,
        path,
        e.name,
        e.kind,
        JSON.stringify(e.exports),
        e.arity,
        e.hash,
      );
    }
    sql.exec("UPDATE files SET parse_state = 'module' WHERE path = ?", path);
  }
  for (const [from, tos] of analysis.refs) {
    for (const to of tos) sql.exec("INSERT OR REPLACE INTO refs (from_key, to_key) VALUES (?, ?)", from, to);
  }

  metaWrite(pool, IMPORT_CURSOR_KEY, null);
  metaWrite(pool, "pool_state", "ready");
  metaWrite(pool, "pause_reason", null);
  emitPoolState(pool); // EM1: `ready` first …
  emitPoolFiles(pool); // … then `pool.files`.
  return { ok: true, done: true };
}
