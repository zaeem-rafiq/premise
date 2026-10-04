// src/core/agent/schema.ts — the Agent Durable Object's SQLite schema.
//
// The tables and columns are those of docs/spec/01-core.md section 3.3 plus
// the timers table of section 3.4. applySchema is idempotent so the Durable
// Object can run it on every start.
//
// Pure: synchronous, no I/O, no Clock, no packages.

/** Every table of the Agent's store, per 01-core 3.3 and 3.4. */
export const AGENT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript (
    step INTEGER PRIMARY KEY,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool TEXT,
    call_id TEXT,
    model TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    started_at INTEGER,
    ended_at INTEGER
  )`,
  // The single row of the write-ahead journal (AG1); id is always 1.
  `CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    kind TEXT NOT NULL,
    call_id TEXT NOT NULL,
    request TEXT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ops (
    op_seq INTEGER PRIMARY KEY,
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS premises (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    hash TEXT NOT NULL,
    seq INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    edit INTEGER NOT NULL DEFAULT 0,
    derived INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
  )`,
  // Inbox rows persist until resolved or pruned (HU4); shown_step is the
  // transcript step that first showed the heads-up.
  `CREATE TABLE IF NOT EXISTS inbox (
    hn INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    shown_step INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    step INTEGER PRIMARY KEY,
    made_at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS timers (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  )`,
];
