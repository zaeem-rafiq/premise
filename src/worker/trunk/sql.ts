// The Trunk Durable Object's SQLite access (01-core 3.2): the `Sql` adapter over `ctx.storage`, the
// shell's tables — `meta`, `events_out` (EV2) and `timers` (AL1, the table Trunk and every Agent
// share) — and the row helpers on them. The engine's tables (`files`, `attempts`, `outbox`, ...)
// arrive with the engine lane; nothing here assumes them. Statements are static strings — no query
// is built from input.

import type { Sql } from "../../protocol/ports.ts";
import { sqlOver } from "../sql-port.ts";
import { EngineSession } from "./engine-session.ts";

const sessions = new WeakMap<DurableObjectStorage, EngineSession>();

/** The `Sql` port of a Durable Object. */
export function sqlOf(ctx: DurableObjectState): EngineSession {
  let session = sessions.get(ctx.storage);
  if (session === undefined) {
    session = new EngineSession(sqlOver(ctx.storage));
    sessions.set(ctx.storage, session);
  }
  return session;
}

/** The shell's schema (01-core 3.2): `meta`, `events_out`, `timers`. `IF NOT EXISTS` leaves the
 * engine's tables — created by its own lane — untouched. */
export const SHELL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS events_out (
    n    INTEGER PRIMARY KEY,
    ts   INTEGER NOT NULL,
    body TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS timers (
    kind   TEXT NOT NULL,
    key    TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  ) WITHOUT ROWID`,
] as const;

export function applyShellSchema(sql: Sql): void {
  for (const ddl of SHELL_SCHEMA) sql.exec(ddl);
}

// ---- meta (3.2) ----

export function metaGet(sql: Sql, key: string): string | null {
  const rows = sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray();
  return rows.length === 0 ? null : String(rows[0]?.v);
}

export function metaSet(sql: Sql, key: string, value: string | number): void {
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", key, String(value));
}

export function metaDelete(sql: Sql, key: string): void {
  sql.exec("DELETE FROM meta WHERE k = ?", key);
}

export function metaAll(sql: Sql): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of sql.exec("SELECT k, v FROM meta").toArray()) out[String(row.k)] = String(row.v);
  return out;
}

// ---- events_out (EV2): the outbox to the Floor, a row deleted only once the Floor confirmed it ----

export type OutboxRow = { n: number; ts: number; body: string; sent: number };

/** Appends one source event (`{ts, pool, src, type, ...}` — no `n`, no `t`; the Floor assigns them)
 * and returns its `source_n`. The engine numbers its own events with `meta.next_event_n`; the
 * shell's appends (`trunk.error`, `push.retry`) share that counter so the two writers never
 * collide on the primary key. */
export function appendEvent(sql: Sql, ts: number, event: Record<string, unknown>): number {
  const meta = sql.exec("SELECT v FROM meta WHERE k = 'next_event_n'").toArray()[0]?.v;
  const rows = sql.exec("SELECT COALESCE(MAX(n), 0) + 1 AS next FROM events_out").toArray();
  const n = Math.max(meta === undefined ? 0 : Number(meta), Number(rows[0]?.next));
  sql.exec("INSERT INTO events_out (n, ts, body, sent) VALUES (?, ?, ?, 0)", n, ts, JSON.stringify(event));
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('next_event_n', ?)", String(n + 1));
  return n;
}

/** The outbox rows the Floor still has to confirm, in send order. */
export function pendingEvents(sql: Sql): OutboxRow[] {
  return sql
    .exec("SELECT n, ts, body, sent FROM events_out ORDER BY n")
    .toArray()
    .map((row) => ({ n: Number(row.n), ts: Number(row.ts), body: String(row.body), sent: Number(row.sent) }));
}

/** Marks the rows as handed to the Floor at least once (EV2 keeps them until confirmation). */
export function markEventsSent(sql: Sql, ns: readonly number[]): void {
  for (const n of ns) sql.exec("UPDATE events_out SET sent = 1 WHERE n = ? AND sent = 0", n);
}

/** Deletes the rows the Floor confirmed: `n <= upTo` (EV2). */
export function confirmEvents(sql: Sql, upTo: number): void {
  sql.exec("DELETE FROM events_out WHERE n <= ?", upTo);
}

// ---- timers (AL1): the one-alarm scheduler ----

export type TimerRow = { kind: string; key: string; due_at: number };

export function timerPut(sql: Sql, kind: string, key: string, dueAt: number): void {
  sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES (?, ?, ?)", kind, key, dueAt);
}

export function timerDelete(sql: Sql, kind: string, key: string): void {
  sql.exec("DELETE FROM timers WHERE kind = ? AND key = ?", kind, key);
}

export function timerList(sql: Sql): TimerRow[] {
  return sql
    .exec("SELECT kind, key, due_at FROM timers ORDER BY due_at")
    .toArray()
    .map((row) => ({ kind: String(row.kind), key: String(row.key), due_at: Number(row.due_at) }));
}

/** The `due_at` of the one `(kind, key)` timer, or null — '' is the single-instance key (3.3). */
export function timerGetDue(sql: Sql, kind: string, key: string): number | null {
  const rows = sql.exec("SELECT due_at FROM timers WHERE kind = ? AND key = ?", kind, key).toArray();
  const d = rows[0]?.due_at;
  return d === null || d === undefined ? null : Number(d);
}

/** The timers whose `due_at` has passed, in `due_at` order (AL1). */
export function timerDue(sql: Sql, now: number): TimerRow[] {
  return timerList(sql).filter((timer) => timer.due_at <= now);
}

/** The smallest `due_at` — the value the single alarm is always set to (AL1) — or null when empty. */
export function timerMin(sql: Sql): number | null {
  const rows = sql.exec("SELECT MIN(due_at) AS d FROM timers").toArray();
  const d = rows[0]?.d;
  return d === null || d === undefined ? null : Number(d);
}
