// src/core/trunk/schema.ts — the Trunk Durable Object's SQLite schema (01-core.md 3.2), plus the
// `timers` table of 3.3 that the same database holds (rule AL1).
//
// applySchema is idempotent so the Durable Object can run it on every start. The schema is the
// whole of 3.2, including the Slice-1 columns `attempts.race`, `attempts.truth`,
// `attempts.resumes` and `heads_ups.op_mark` and the `meta` keys `summary_only` and `synthetic`.
//
// Pure: synchronous, no I/O, no Clock, no packages. SQ1: no LIKE or GLOB in any SQL text.

import type { Sql } from "../../protocol/ports.ts";

export const SCHEMA_VERSION = "1";
export const HASH_VERSION = "ast1";

/** Every table of 01-core.md 3.2 (and the `timers` table the section's tail names). */
export const TRUNK_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS files (
    path        TEXT PRIMARY KEY,
    mode        TEXT NOT NULL DEFAULT '100644',
    oid         TEXT NOT NULL,
    content     BLOB,
    parse_state TEXT NOT NULL,
    changed_seq INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS trees (
    dir TEXT PRIMARY KEY,
    oid TEXT NOT NULL
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS entities (
    key         TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    exports     TEXT NOT NULL,
    arity       INTEGER,
    hash        TEXT NOT NULL,
    changed_seq INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS entities_path ON entities(path)`,

  `CREATE TABLE IF NOT EXISTS refs (
    from_key TEXT NOT NULL,
    to_key   TEXT NOT NULL,
    PRIMARY KEY (from_key, to_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS refs_to ON refs(to_key)`,

  `CREATE TABLE IF NOT EXISTS intents (
    intent_id  TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    requester  TEXT NOT NULL,
    race       INTEGER NOT NULL DEFAULT 0,
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS attempts (
    attempt_id      TEXT PRIMARY KEY,
    intent_id       TEXT NOT NULL,
    change_id       TEXT NOT NULL UNIQUE,
    agent_kind      TEXT NOT NULL,
    model           TEXT,
    race            INTEGER NOT NULL DEFAULT 0,
    truth           TEXT,
    resumes         INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL,
    stop_reason     TEXT,
    go_arounds      INTEGER NOT NULL DEFAULT 0,
    pull_backs      INTEGER NOT NULL DEFAULT 0,
    revision        INTEGER NOT NULL DEFAULT 1,
    right_of_way_at INTEGER,
    opened_seq      INTEGER NOT NULL,
    submit_id       TEXT,
    summary         TEXT,
    tier            TEXT,
    approved_by     TEXT,
    bypass_row      INTEGER NOT NULL DEFAULT 0,
    sets            TEXT,
    submitted_at    INTEGER,
    validated_at    INTEGER,
    landed_seq      INTEGER,
    attempt_repo    TEXT,
    last_call_id    TEXT,
    last_response   TEXT,
    ack             INTEGER NOT NULL DEFAULT 0,
    next_hn         INTEGER NOT NULL DEFAULT 1,
    updated_at      INTEGER NOT NULL,
    model_calls     INTEGER NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS attempts_state ON attempts(state, validated_at)`,
  `CREATE INDEX IF NOT EXISTS attempts_intent ON attempts(intent_id)`,

  `CREATE TABLE IF NOT EXISTS premises (
    attempt_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    hash       TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    members    TEXT,
    shown      TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    edit       INTEGER NOT NULL DEFAULT 0,
    derived    INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'holds',
    PRIMARY KEY (attempt_id, kind, key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS premises_key ON premises(kind, key)`,

  `CREATE TABLE IF NOT EXISTS ops (
    attempt_id TEXT NOT NULL,
    op_seq     INTEGER NOT NULL,
    op         TEXT NOT NULL,
    path       TEXT NOT NULL,
    content    TEXT,
    old        TEXT,
    new        TEXT,
    base_oid   TEXT,
    targets    TEXT,
    dropped    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (attempt_id, op_seq)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS ops_first (
    attempt_id TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    ops        TEXT NOT NULL,
    submitted  INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, revision)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS heads_ups (
    attempt_id   TEXT NOT NULL,
    hn           INTEGER NOT NULL,
    result       TEXT NOT NULL,
    wake         INTEGER NOT NULL,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    received_at  INTEGER,
    delivered_at INTEGER,
    resolved_at  INTEGER,
    statement    TEXT,
    op_mark      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (attempt_id, hn)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS judgments (
    judgment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    key         TEXT NOT NULL,
    old_hash    TEXT NOT NULL,
    new_hash    TEXT NOT NULL,
    cause       TEXT NOT NULL,
    cause_seq   INTEGER,
    rule        TEXT NOT NULL,
    class       TEXT NOT NULL,
    result      TEXT,
    asked_op_seq INTEGER,
    asked_at    INTEGER,
    tries       INTEGER NOT NULL DEFAULT 0,
    reason      TEXT NOT NULL,
    clef_model  TEXT,
    clef_p      REAL,
    clef_ms     INTEGER,
    clef_error  TEXT,
    t_repair    REAL,
    t_confirm   REAL,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS judgments_attempt ON judgments(attempt_id)`,

  `CREATE TABLE IF NOT EXISTS landings (
    seq          INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    change_id    TEXT NOT NULL,
    attempt_id   TEXT,
    intent_id    TEXT,
    batch_id     INTEGER NOT NULL,
    commit_oid   TEXT NOT NULL,
    parent_oid   TEXT NOT NULL,
    tree_oid     TEXT NOT NULL,
    note_oid     TEXT NOT NULL,
    note         TEXT NOT NULL,
    submitted_at INTEGER,
    accepted_at  INTEGER NOT NULL,
    pushed_at    INTEGER,
    undone_by    INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS landing_files (
    seq     INTEGER NOT NULL,
    path    TEXT NOT NULL,
    old_oid TEXT NOT NULL,
    new_oid TEXT NOT NULL,
    PRIMARY KEY (seq, path)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS landing_writes (
    seq      INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    key      TEXT NOT NULL,
    old_hash TEXT NOT NULL,
    new_hash TEXT NOT NULL,
    PRIMARY KEY (seq, kind, key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS landing_writes_key ON landing_writes(kind, key, seq)`,

  `CREATE TABLE IF NOT EXISTS landing_premises (
    seq     INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    key     TEXT NOT NULL,
    hash    TEXT NOT NULL,
    pin_seq INTEGER NOT NULL,
    read    INTEGER NOT NULL,
    edit    INTEGER NOT NULL,
    derived INTEGER NOT NULL,
    PRIMARY KEY (seq, kind, key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS landing_premises_key ON landing_premises(kind, key)`,

  `CREATE TABLE IF NOT EXISTS landing_ops (
    seq    INTEGER NOT NULL,
    op_seq INTEGER NOT NULL,
    body   TEXT NOT NULL,
    PRIMARY KEY (seq, op_seq)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS blobs (
    oid     TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    seq     INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS outbox (
    batch_id   INTEGER PRIMARY KEY,
    state      TEXT NOT NULL,
    first_seq  INTEGER NOT NULL,
    last_seq   INTEGER NOT NULL,
    old_main   TEXT NOT NULL,
    new_main   TEXT NOT NULL,
    old_notes  TEXT NOT NULL,
    new_notes  TEXT NOT NULL,
    tries      INTEGER NOT NULL DEFAULT 0,
    rejects    INTEGER NOT NULL DEFAULT 0,
    next_try   INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    pushed_at  INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS outbox_chunks (
    batch_id INTEGER NOT NULL,
    i        INTEGER NOT NULL,
    bytes    BLOB NOT NULL,
    PRIMARY KEY (batch_id, i)
  )`,

  `CREATE TABLE IF NOT EXISTS cards (
    card_id    TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    state      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at  INTEGER
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS undo_requests (
    request_id TEXT PRIMARY KEY,
    target_seq INTEGER NOT NULL,
    cause      TEXT NOT NULL,
    state      TEXT NOT NULL,
    detail     TEXT
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS events_out (
    n    INTEGER PRIMARY KEY,
    ts   INTEGER NOT NULL,
    body TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  )`,

  // The `timers` table of 3.3 that 3.2's tail adds to this database (rule AL1).
  `CREATE TABLE IF NOT EXISTS timers (
    kind TEXT NOT NULL,
    key  TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  ) WITHOUT ROWID`,

  // TR10: the Clef question store — one row per pending triage premise (src/core/trunk/triage.ts).
  `CREATE TABLE IF NOT EXISTS triage_asks (
    attempt_id    TEXT NOT NULL,
    kind          TEXT NOT NULL,
    key           TEXT NOT NULL,
    decider_id    TEXT NOT NULL,
    frozen        TEXT NOT NULL,
    asked_op_seq  INTEGER NOT NULL,
    dispatched_at INTEGER,
    deadline_at   INTEGER,
    tries         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (attempt_id, kind, key)
  ) WITHOUT ROWID`,
];

/** The `meta` keys of 3.2 that a fresh pool carries. */
export const META_KEYS = [
  "schema_version",
  "hash_version",
  "pool_id",
  "head_seq",
  "head_commit",
  "head_tree",
  "notes_commit",
  "green_seq",
  "green_commit",
  "pool_state",
  "pause_reason",
  "next_batch_id",
  "next_event_n",
  "epoch",
  "rebuild_cursor",
  "repo",
  "repo_generation",
  "plain_commit",
  "plain_through_seq",
  "summary_only",
  "synthetic",
] as const;

export function applySchema(sql: Sql): void {
  for (const ddl of TRUNK_SCHEMA) sql.exec(ddl);
  migrateSchema(sql);
}

/** Columns added after the first pools existed: `applySchema` covers a fresh database; a pool
 * created before the columns joined `attempts` gets them here, before any `SELECT` names them
 * (TA10: the usage totals of `ToolRequest.usage` are stored on the attempt). */
export function migrateSchema(sql: Sql): void {
  const exists =
    sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempts'").toArray().length > 0;
  if (!exists) return;
  const cols = new Set(
    sql
      .exec("SELECT name FROM pragma_table_info('attempts')")
      .toArray()
      .map((r) => String(r.name)),
  );
  for (const c of ["model_calls", "tokens_in", "tokens_out"] as const) {
    if (!cols.has(c)) sql.exec(`ALTER TABLE attempts ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  }
}

export function metaGet(sql: Sql, k: string): string | null {
  const rows = sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
  return rows.length === 0 ? null : String(rows[0]?.v);
}

export function metaSet(sql: Sql, k: string, v: string | number | null): void {
  // Some handlers also write through before persist. Compare with SQLite so those writes,
  // retries and a rolled-back transaction never cause an unchanged row to be written.
  if (metaGet(sql, k) === (v === null ? null : String(v))) return;
  if (v === null) {
    sql.exec("DELETE FROM meta WHERE k = ?", k);
    return;
  }
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, String(v));
}

export function metaAll(sql: Sql): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of sql.exec("SELECT k, v FROM meta").toArray()) {
    out.set(String(row.k), String(row.v));
  }
  return out;
}
