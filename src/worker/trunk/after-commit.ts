// What runs after a transaction commits (SY2, LP3): the engine's effects — sent over the network only
// once the decision they describe is durable — and the outbox delivery of EV2, Trunk's own effect.
//
// `deliverEvents` is the `events` handler wired in `wiring/trunk.ts` and the flush the shell runs at
// the end of every request: Trunk wrote `events_out` rows in the same transaction as the change, and
// a row leaves only when the Floor confirmed it (EV2). A rejected gap re-sends from the Floor's
// `last_n + 1`; a transport failure keeps the rows under an `events` timer with backoff (AL1, AL2).

import { PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { effectTable, type EffectInput } from "./effects.ts";
import type { Sql } from "../../protocol/ports.ts";
import {
  appendEvent,
  confirmEvents,
  markEventsSent,
  metaDelete,
  metaGet,
  metaSet,
  pendingEvents,
  sqlOf,
  timerDelete,
  timerGetDue,
  timerPut,
} from "./sql.ts";

const FLOOR_EVENTS = "https://floor.internal/internal/events";

/** One effect an entry left for after the commit: `{ kind, payload? }` as the wiring names it. */
export type EffectRef = { kind: string; payload?: unknown };

/** A `trunk.error` event (SE5b: a fixed code, never raw error text) in its own transaction, so a
 * failed effect — or a failed entry — still leaves a mark. Delivery follows the `events` timer. */
export function recordTrunkError(ctx: DurableObjectState, where: string, code: string): void {
  const sql = sqlOf(ctx);
  const now = Date.now();
  try {
    sql.transaction(() => {
      appendEvent(sql, now, {
        ts: now,
        pool: ctx.id.name ?? "",
        src: "trunk",
        type: "trunk.error",
        where,
        code,
      });
      // Arm the delivery timer only when none exists — a live backoff is a deliberate future due
      // (AL2), and an in-flight one does not need a second.
      if (timerGetDue(sql, "events", "") === null) timerPut(sql, "events", "", now);
    });
  } catch {
    // The store itself failed: nothing durable remains to write to.
  }
}

/** Schedules the `events` timer for the next delivery try: `PUSH_BACKOFF_BASE_MS`-backed exponential
 * backoff, capped at `PUSH_BACKOFF_MAX_MS` (the push cadence constants of Appendix C; the spec gives
 * the events retry no table of its own). */
export function scheduleEventsRetry(sql: Sql): void {
  sql.transaction(() => {
    const tries = Number(metaGet(sql, "events_tries") ?? "0") + 1;
    metaSet(sql, "events_tries", tries);
    timerPut(sql, "events", "", Date.now() + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS));
  });
}

/**
 * Sends every unconfirmed `events_out` row to the pool's Floor as `{ source: "trunk", epoch, events:
 * [{ source_n, event }] }` (EV2). Confirmed rows are deleted in a transaction after the answer — a
 * crash between send and confirm only means the Floor sees the row again, which EV2 makes safe.
 */
export async function deliverEvents(env: Env, ctx: DurableObjectState): Promise<void> {
  const sql = sqlOf(ctx);
  const pool = ctx.id.name ?? "";
  for (let round = 0; round < 2; round += 1) {
    const rows = pendingEvents(sql);
    if (rows.length === 0) {
      sql.transaction(() => {
        metaDelete(sql, "events_tries");
        timerDelete(sql, "events", "");
      });
      return;
    }
    const epoch = Number(metaGet(sql, "epoch") ?? "1");
    let response: Response;
    try {
      response = await env.FLOOR.get(env.FLOOR.idFromName(pool)).fetch(FLOOR_EVENTS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "trunk",
          epoch,
          events: rows.map((row) => ({ source_n: row.n, event: JSON.parse(row.body) })),
        }),
      });
    } catch {
      scheduleEventsRetry(sql);
      recordTrunkError(ctx, "events", "transport");
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      appended?: number;
      duplicate?: boolean;
      error?: { code?: string; expected?: number };
    } | null;
    if (response.ok && body !== null && (body.duplicate === true || Number.isInteger(body.appended))) {
      // EV2: every sent row is stored — appended now or already there — so all are confirmed.
      const last = rows[rows.length - 1]?.n ?? 0;
      sql.transaction(() => {
        confirmEvents(sql, last);
        metaDelete(sql, "events_tries");
        timerDelete(sql, "events", "");
      });
      return;
    }
    const expected = body?.error?.expected;
    if (response.status === 409 && body?.error?.code === "gap" && typeof expected === "number") {
      // The Floor is ahead: rows below `expected` are already stored — drop and resend (EV2).
      sql.transaction(() => {
        confirmEvents(sql, expected - 1);
        markEventsSent(
          sql,
          rows.filter((row) => row.n >= expected).map((row) => row.n),
        );
      });
      continue;
    }
    // Only unconfirmed rows need the diagnostic mark. A confirmed row was deleted above,
    // without first rewriting it, and every retained row stays eligible for delivery (EV2).
    sql.transaction(() =>
      markEventsSent(
        sql,
        rows.map((row) => row.n),
      ),
    );
    scheduleEventsRetry(sql);
    recordTrunkError(ctx, "events", "transport");
    return;
  }
  scheduleEventsRetry(sql);
}

/**
 * Runs the effects an entry returned, in order — `events` first, since EV3 hands a batch's events to
 * the Floor before any push starts. A handler that throws leaves a `trunk.error` event (SE5b) and
 * does not stop the rest; an unknown kind leaves one too (a lane emitted what nobody wired).
 */
export async function runEffects(env: Env, ctx: DurableObjectState, effects: readonly EffectRef[]): Promise<void> {
  const table = effectTable();
  const ordered = [...effects].sort((a, b) => Number(b.kind === "events") - Number(a.kind === "events"));
  for (const effect of ordered) {
    const handler = table.handlers.get(effect.kind);
    if (handler === undefined) {
      recordTrunkError(ctx, "effects", "effect_unknown");
      continue;
    }
    const input: EffectInput = { kind: effect.kind, payload: effect.payload, env, ctx };
    try {
      await handler(input);
    } catch {
      recordTrunkError(ctx, "effects", "effect_failed");
    }
  }
}
