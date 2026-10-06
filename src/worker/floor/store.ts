// The Floor Durable Object's SQLite storage (01-core 3.4): `events` (the stream, `n` total and
// contiguous per pool, EV1), `sources` (de-duplication of at-least-once delivery, EV2/EV2a),
// `snapshots` (the reducer state in parts of at most 1 MiB, for fast joins) and `meta`.
//
// The module is synchronous end to end: `ctx.storage.sql.exec` is a synchronous call, and appending
// events must not yield, so a batch that several sources confirm cannot interleave (EV2).

import type { PoolEvent } from "../../protocol/events.ts";
import type { FloorState } from "../../protocol/reducer/index.ts";
import { emptyFloorState, reduce } from "../../protocol/reducer/index.ts";

/** One part of a stored snapshot is at most 1 MiB (01-core 3.4). */
const SNAPSHOT_PART_BYTES = 1_048_576;

export type EventRow = { n: number; t: number; ts: number; type: string; body: string };

/** Creates the four tables of 01-core 3.4 once per object. */
export function initSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS events (
    n    INTEGER PRIMARY KEY,
    t    INTEGER NOT NULL,
    ts   INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sources (
    source TEXT PRIMARY KEY,
    epoch  INTEGER NOT NULL DEFAULT 1,
    last_n INTEGER NOT NULL
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    n     INTEGER NOT NULL,
    part  INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (n, part)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
}

/** The newest `swarm.state` the swarm source appended (EV2a): read by `/internal/swarm-source`. */
export function swarmNewest(sql: SqlStorage): { ts: number; event: Record<string, unknown> } | null {
  const rows = sql.exec("SELECT v FROM meta WHERE k = 'swarm_newest'").toArray() as Array<{ v: string }>;
  const raw = rows[0]?.v;
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as { ts: number; event: Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Records the newest `swarm.state` the swarm source appended. */
export function recordSwarmNewest(sql: SqlStorage, event: PoolEvent): void {
  sql.exec(
    "INSERT INTO meta (k, v) VALUES ('swarm_newest', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
    JSON.stringify({ ts: event.ts, event }),
  );
}

/** The stored `(epoch, last_n)` of one source; null the first time it sends. */
export function sourceRow(sql: SqlStorage, source: string): { epoch: number; last_n: number } | null {
  const rows = sql.exec("SELECT epoch, last_n FROM sources WHERE source = ?", source).toArray() as Array<{
    epoch: number;
    last_n: number;
  }>;
  return rows[0] ?? null;
}

export function recordSource(sql: SqlStorage, source: string, epoch: number, lastN: number): void {
  sql.exec(
    "INSERT INTO sources (source, epoch, last_n) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET epoch = excluded.epoch, last_n = excluded.last_n",
    source,
    epoch,
    lastN,
  );
}

/** The highest `n` in the stream, 0 when empty. */
export function maxN(sql: SqlStorage): number {
  const rows = sql.exec("SELECT MAX(n) AS n FROM events").toArray() as Array<{ n: number | null }>;
  return rows[0]?.n ?? 0;
}

/** Inserts one already-numbered event row. The caller keeps `n` contiguous (EV1). */
export function insertEvent(sql: SqlStorage, event: PoolEvent): void {
  sql.exec(
    "INSERT INTO events (n, t, ts, type, body) VALUES (?, ?, ?, ?, ?)",
    event.n,
    event.t,
    event.ts,
    event.type,
    JSON.stringify(event),
  );
}

/** The stored events with `n > after`, in `n` order. */
export function eventsAfter(sql: SqlStorage, after: number): PoolEvent[] {
  const rows = sql.exec("SELECT body FROM events WHERE n > ? ORDER BY n", after).toArray() as Array<{ body: string }>;
  return rows.map((row) => JSON.parse(row.body) as PoolEvent);
}

/** The `landing.landed` event of one landing, or null (the note route of 13.6). */
export function landingEvent(sql: SqlStorage, seq: number): PoolEvent | null {
  const rows = sql
    .exec("SELECT body FROM events WHERE type = 'landing.landed' AND json_extract(body, '$.seq') = ? LIMIT 1", seq)
    .toArray() as Array<{ body: string }>;
  const row = rows[0];
  return row === undefined ? null : (JSON.parse(row.body) as PoolEvent);
}

/** Every stored event, in `n` order (replay export, snapshot rebuild). */
export function allEvents(sql: SqlStorage): PoolEvent[] {
  return eventsAfter(sql, 0);
}

/** Writes the reducer state at `n`, chunked into `snapshots` parts, replacing older snapshots. */
export function writeSnapshot(sql: SqlStorage, n: number, state: FloorState): void {
  const text = JSON.stringify(state);
  sql.exec("DELETE FROM snapshots WHERE n != ?", n);
  sql.exec("DELETE FROM snapshots WHERE n = ?", n);
  for (let part = 0, offset = 0; offset < text.length || part === 0; part += 1, offset += SNAPSHOT_PART_BYTES) {
    sql.exec(
      "INSERT INTO snapshots (n, part, bytes) VALUES (?, ?, ?)",
      n,
      part,
      text.slice(offset, offset + SNAPSHOT_PART_BYTES),
    );
    if (offset + SNAPSHOT_PART_BYTES >= text.length) break;
  }
}

/** The `n` of the newest stored snapshot, or null. */
export function newestSnapshotN(sql: SqlStorage): number | null {
  const rows = sql.exec("SELECT MAX(n) AS n FROM snapshots").toArray() as Array<{ n: number | null }>;
  return rows[0]?.n ?? null;
}

/** Reads the newest snapshot's parts and parses the state; null when none is stored. */
export function readNewestSnapshot(sql: SqlStorage): { n: number; state: FloorState } | null {
  const n = newestSnapshotN(sql);
  if (n === null) return null;
  const rows = sql.exec("SELECT bytes FROM snapshots WHERE n = ? ORDER BY part", n).toArray() as Array<{
    bytes: string;
  }>;
  return { n, state: JSON.parse(rows.map((row) => row.bytes).join("")) as FloorState };
}

/**
 * The reducer state at the stream's newest `n`: the newest snapshot plus a replay of the events
 * stored after it (EV5, FE3 — snapshot join and replay from `n = 1` must agree).
 */
export function loadState(sql: SqlStorage): { n: number; state: FloorState } {
  const snapshot = readNewestSnapshot(sql);
  const after = snapshot?.n ?? 0;
  const state = snapshot?.state ?? emptyFloorState();
  let n = after;
  for (const event of eventsAfter(sql, after)) {
    reduce(state, event);
    n = event.n;
  }
  return { n, state };
}
