// src/core/trunk/events.ts — the `events_out` append path (01-core.md 12). Every state change
// the engine makes emits a `PoolEvent` of `src: "trunk"`, numbered `next_event_n` with no gaps.
// For the case driver the trace keeps just the type names; the rows keep the full body.

import type { Pool } from "./sets.ts";
import { metaSet } from "./schema.ts";

/**
 * Append one event: numbered `next_event_n`, clock from `pool.now()`, and persisted immediately
 * inside the call's transaction. `fields` is the type's body without the envelope keys.
 */
export function event(pool: Pool, type: string, fields: Record<string, unknown>): void {
  const n = pool.eventCounter;
  pool.eventCounter += 1;
  pool.meta.set("next_event_n", String(pool.eventCounter));
  const body = {
    n,
    t: pool.now(),
    ts: pool.now(),
    pool: pool.meta.get("pool_id") ?? "",
    src: "trunk",
    type,
    ...fields,
  };
  pool.sql.exec("INSERT INTO events_out (n, ts, body, sent) VALUES (?, ?, ?, 0)", n, pool.now(), JSON.stringify(body));
  pool.out.events.push(type);
}

export function metaWrite(pool: Pool, k: string, v: string | number | null): void {
  pool.meta.set(k, v === null ? "" : String(v));
  metaSet(pool.sql, k, v);
}
