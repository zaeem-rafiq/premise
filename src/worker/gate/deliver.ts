// The `limits` delivery of EV2a: the gate is a source that serves every pool, so it keeps one
// outbox per pool and follows EV2 for it — events in order, a re-send from the Floor's
// `last_n + 1` after a gap, a row deleted only when the Floor confirmed it, and a retry when the
// Floor does not answer. Same contract as Trunk's `deliverEvents` (src/worker/trunk/after-commit.ts),
// keyed per pool because the gate has many streams instead of one.
//
// The retry cadence reuses the push backoff constants (PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS):
// the specification gives the events retry no table of its own, so the gate's retries follow the
// same cadence as Trunk's (after-commit.ts makes the same choice for its `events` timer).

import { PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import type { FloorAppendResponse } from "../../protocol/internal.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import {
  nextRetryAt,
  outboxConfirm,
  outboxPending,
  outboxPoolDelete,
  outboxPoolGet,
  outboxPools,
  outboxPoolSet,
} from "./store.ts";

const FLOOR_EVENTS = "https://floor.internal/internal/events";
const SOURCE = "gate";

/** The pools whose retry is already due at `now`. */
export function duePools(sql: Sql, now: number): string[] {
  return outboxPools(sql).filter((pool) => outboxPoolGet(sql, pool).retry_at <= now);
}

/** Records a failed delivery: the retry is due at `now` + PUSH_BACKOFF_BASE_MS * 2^tries, capped. */
function scheduleRetry(sql: Sql, pool: string, now: number): void {
  const tries = outboxPoolGet(sql, pool).tries + 1;
  const at = now + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS);
  sql.transaction(() => outboxPoolSet(sql, pool, tries, at));
}

/**
 * Sends every row a pool's Floor has not confirmed, as `{ source: "gate", epoch, events }` (EV2a).
 * On a confirmed answer the sent rows are deleted in one transaction — a crash between send and
 * confirm only means the Floor sees them again, which EV2 makes safe. On a `gap` answer the rows
 * below `expected` are confirmed and the rest is sent again. Anything else arms the retry.
 */
export async function deliverPool(env: Env, sql: Sql, pool: string): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    const rows = outboxPending(sql, pool);
    if (rows.length === 0) {
      sql.transaction(() => outboxPoolDelete(sql, pool));
      return;
    }
    const floor = env.FLOOR as DurableObjectNamespace | undefined;
    let response: Response;
    try {
      if (floor === undefined) throw new Error("no FLOOR binding");
      response = await floor.get(floor.idFromName(pool)).fetch(FLOOR_EVENTS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: SOURCE,
          epoch: rows[0]?.epoch ?? 1,
          events: rows.map((row) => ({ source_n: row.n, event: JSON.parse(row.event) })),
        }),
      });
    } catch {
      scheduleRetry(sql, pool, Date.now());
      return;
    }
    const body = (await response.json().catch(() => null)) as FloorAppendResponse | null;
    const error = body !== null && "error" in body ? body.error : null;
    if (response.ok && error === null) {
      const last = rows[rows.length - 1]?.n ?? 0;
      sql.transaction(() => {
        outboxConfirm(sql, pool, last);
        outboxPoolDelete(sql, pool);
      });
      return;
    }
    const expected = error?.expected;
    if (response.status === 409 && error?.code === "gap" && typeof expected === "number") {
      // The Floor is ahead: rows below `expected` are already stored — drop and resend (EV2).
      sql.transaction(() => outboxConfirm(sql, pool, expected - 1));
      continue;
    }
    scheduleRetry(sql, pool, Date.now());
    return;
  }
  scheduleRetry(sql, pool, Date.now());
}

/** Delivers every pool whose retry is due at `now`. */
export async function deliverDue(env: Env, sql: Sql, now: number): Promise<void> {
  for (const pool of duePools(sql, now)) {
    try {
      await deliverPool(env, sql, pool);
    } catch (cause) {
      console.error(
        "gate event delivery failed",
        cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
      );
      scheduleRetry(sql, pool, now);
    }
  }
}

export { nextRetryAt };
