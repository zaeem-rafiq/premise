// The model gate's durable layout in its own SQLite (one object per deployment, named "premise").
//
//   gate_meta    the one GateState JSON under k = 'state' (SE12: `killed` survives a restart
//                because it is part of that state) and the delivery bookkeeping keys
//   outbox       the `limits` events each registered pool is still owed (EV2a): a row leaves
//                only when the pool's Floor confirmed it, exactly like Trunk's `events_out`
//   outbox_pool  the per-pool delivery position: tries so far and when the next try is due
//   try_log      09-try TY6a: one row per visitor's try of the last hour — its time, and the
//                salted hash of its client address while the address window lasts
//
// Statements are static strings — no query is built from input.

import type { Sql } from "../../protocol/ports.ts";

export const GATE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS gate_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS outbox (
    pool  TEXT NOT NULL,
    n     INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY (pool, n)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_pool (
    pool     TEXT PRIMARY KEY,
    tries    INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS try_log (t INTEGER NOT NULL, h TEXT)",
] as const;

export function applyGateSchema(sql: Sql): void {
  for (const ddl of GATE_SCHEMA) sql.exec(ddl);
}

// ---- gate_meta ----

export function gateMetaGet(sql: Sql, key: string): string | null {
  const rows = sql.exec("SELECT v FROM gate_meta WHERE k = ?", key).toArray();
  return rows.length === 0 ? null : String(rows[0]?.v);
}

export function gateMetaSet(sql: Sql, key: string, value: string | number): void {
  sql.exec("INSERT OR REPLACE INTO gate_meta (k, v) VALUES (?, ?)", key, String(value));
}

// ---- outbox (EV2a): one ordered queue per registered pool ----

export type OutboxEvent = { pool: string; n: number; epoch: number; event: string };

/** Adds the event an `emit` effect carries (the pure gate already numbered it `source_n`). */
export function outboxAppend(sql: Sql, pool: string, epoch: number, sourceN: number, event: unknown): void {
  sql.exec(
    "INSERT INTO outbox (pool, n, epoch, event) VALUES (?, ?, ?, ?)",
    pool,
    sourceN,
    epoch,
    JSON.stringify(event),
  );
}

/** The rows a pool's Floor has not confirmed, in send order. */
export function outboxPending(sql: Sql, pool: string): OutboxEvent[] {
  return sql
    .exec("SELECT pool, n, epoch, event FROM outbox WHERE pool = ? ORDER BY n", pool)
    .toArray()
    .map((row) => ({
      pool: String(row.pool),
      n: Number(row.n),
      epoch: Number(row.epoch),
      event: String(row.event),
    }));
}

/** Every pool that still has unconfirmed rows. */
export function outboxPools(sql: Sql): string[] {
  return sql
    .exec("SELECT DISTINCT pool FROM outbox ORDER BY pool")
    .toArray()
    .map((row) => String(row.pool));
}

/** EV2a: a row is deleted only when the Floor confirmed it — everything up to `through` is stored. */
export function outboxConfirm(sql: Sql, pool: string, through: number): void {
  sql.exec("DELETE FROM outbox WHERE pool = ? AND n <= ?", pool, through);
}

// ---- outbox_pool: per-pool retry position ----

export type OutboxPool = { pool: string; tries: number; retry_at: number };

export function outboxPoolGet(sql: Sql, pool: string): OutboxPool {
  const row = sql.exec("SELECT pool, tries, retry_at FROM outbox_pool WHERE pool = ?", pool).toArray()[0];
  return row === undefined
    ? { pool, tries: 0, retry_at: 0 }
    : { pool: String(row.pool), tries: Number(row.tries), retry_at: Number(row.retry_at) };
}

export function outboxPoolSet(sql: Sql, pool: string, tries: number, retryAt: number): void {
  sql.exec("INSERT OR REPLACE INTO outbox_pool (pool, tries, retry_at) VALUES (?, ?, ?)", pool, tries, retryAt);
}

export function outboxPoolDelete(sql: Sql, pool: string): void {
  sql.exec("DELETE FROM outbox_pool WHERE pool = ?", pool);
}

/** Every outbox row — the `/internal/state` dump's view of what each pool is still owed. */
export function outboxAll(sql: Sql): OutboxEvent[] {
  return sql
    .exec("SELECT pool, n, epoch, event FROM outbox ORDER BY pool, n")
    .toArray()
    .map((row) => ({
      pool: String(row.pool),
      n: Number(row.n),
      epoch: Number(row.epoch),
      event: String(row.event),
    }));
}

/** Every pool's retry position — the dump's view alongside `outboxAll`. */
export function outboxPoolAll(sql: Sql): OutboxPool[] {
  return sql
    .exec("SELECT pool, tries, retry_at FROM outbox_pool ORDER BY pool")
    .toArray()
    .map((row) => ({ pool: String(row.pool), tries: Number(row.tries), retry_at: Number(row.retry_at) }));
}

/** The next moment a delivery retry is due, or null when nothing waits or every wait is already
 * due (the alarm arms to it). */
export function nextRetryAt(sql: Sql, now: number): number | null {
  const row = sql
    .exec(
      "SELECT MIN(retry_at) AS at FROM outbox_pool WHERE retry_at > ? AND pool IN (SELECT DISTINCT pool FROM outbox)",
      now,
    )
    .toArray()[0];
  return row === undefined || row.at === null ? null : Number(row.at);
}

// ---- try_log (09-try TY6a) ----

export type TryLogRow = { t: number; h: string | null };

/** TY6a: drops the rows at or before `drop` and erases the hash of the rows at or before `erase`
 * (`tryCutoffs`), then answers what is left. */
export function tryLogPrune(sql: Sql, drop: number, erase: number): TryLogRow[] {
  sql.exec("DELETE FROM try_log WHERE t <= ?", drop);
  sql.exec("UPDATE try_log SET h = NULL WHERE t <= ? AND h IS NOT NULL", erase);
  return sql
    .exec("SELECT t, h FROM try_log ORDER BY t")
    .toArray()
    .map((row) => ({ t: Number(row.t), h: row.h === null ? null : String(row.h) }));
}

export function tryLogAppend(sql: Sql, t: number, h: string): void {
  sql.exec("INSERT INTO try_log (t, h) VALUES (?, ?)", t, h);
}
