// Repair the legacy RB5 failure where an old epoch's confirmation removed only the new
// epoch's first row. RB5 defines that row as pool.state; the intact suffix contains every
// later state change. No attempt, landing or card event can safely be invented from a gap.

import type { Sql } from "../../protocol/ports.ts";
import { poolStateBody } from "../../core/trunk/events.ts";
import { openPool } from "../../core/trunk/registry.ts";
import { metaGet, pendingEvents } from "./sql.ts";

/** Restores the missing bootstrap without renumbering or deleting any unconfirmed event.
 * The Floor commits the snapshot and the intact suffix together, restoring current pool
 * state and the retained event effects. The bootstrap and stale-card closure timestamps
 * describe recovery, not the lost historical snapshot. */
export function restoreRebuildBootstrap(sql: Sql, epoch: number, expected: number, now: number): boolean {
  return sql.transaction(() => {
    if (epoch <= 1 || expected !== 1 || Number(metaGet(sql, "epoch")) !== epoch) return false;
    const rows = pendingEvents(sql);
    if (rows[0]?.n !== 2 || rows.some((row, index) => row.n !== index + 2)) return false;
    if (Number(metaGet(sql, "next_event_n")) !== rows.length + 2) return false;
    const pool = openPool(sql, { now: () => now });
    const event = {
      ts: now,
      pool: pool.meta.get("pool_id") ?? "",
      src: "trunk",
      type: "pool.state",
      ...poolStateBody(pool),
    };
    sql.exec("INSERT INTO events_out (n, ts, body, sent) VALUES (1, ?, ?, 0)", now, JSON.stringify(event));
    return true;
  });
}
