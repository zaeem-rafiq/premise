// The one alarm of AL1-AL4 (01-core 3.3, 3.4): always set to the smallest `due_at` in `timers`. The
// handler runs every due timer in `due_at` order, deletes or re-schedules each one, and re-arms the
// alarm before it returns. A timer's work is the shell's own `events` kind (the EV2 outbox flush) or
// an engine entry registered under the timer's kind — run through the same transaction-then-effects
// shape as a request (SY2). No network call happens inside `blockConcurrencyWhile` or inside a
// transaction (AL4).

import { PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { deliverEvents, recordTrunkError } from "./after-commit.ts";
import { metaGet, metaSet, timerDelete, timerDue, timerMin, timerPut, type TimerRow } from "./sql.ts";

export type AlarmDeps = {
  env: Env;
  ctx: DurableObjectState;
  sql: Sql;
  /** Runs the engine entry registered under a timer's kind. Resolves false when no entry is
   * registered; rejects when the entry itself threw (its transaction already rolled back). */
  runEntry: (kind: string, input: { timer: TimerRow }) => Promise<boolean>;
  /** The `push` timer's work (9.6): the outbox's due push and its LP5 apply. */
  push?: () => Promise<void>;
  /** The `repush` timer's work (HU5b): heads-up delivery to the attempt's Agent. */
  repush?: () => Promise<void>;
};

/** AL1: the alarm is always set to the smallest `due_at` — or deleted when `timers` is empty. */
export async function armAlarm(ctx: DurableObjectState, sql: Sql): Promise<void> {
  const min = timerMin(sql);
  if (min === null) {
    await ctx.storage.deleteAlarm();
    return;
  }
  await ctx.storage.setAlarm(min);
}

/** AL2: a failed (or unhandled) timer keeps its row at a backoff — never dropped, never retried in
 * a hot loop — and the failure leaves a `trunk.error` event with a fixed code (SE5b). */
function rescheduleTimer(sql: Sql, timer: TimerRow): void {
  sql.transaction(() => {
    const failsKey = `timer_fails:${timer.kind}:${timer.key}`;
    const tries = Number(metaGet(sql, failsKey) ?? "0") + 1;
    metaSet(sql, failsKey, tries);
    timerPut(sql, timer.kind, timer.key, Date.now() + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** tries, PUSH_BACKOFF_MAX_MS));
  });
}

/**
 * The alarm handler: every due timer in `due_at` order. The `events` timer is the outbox flush —
 * `deliverEvents` deletes or re-schedules the row itself as the Floor answers. An engine timer is
 * deleted before its entry runs, so an entry that re-arms itself is not clobbered; a throw puts the
 * row back with a backoff (AL2). The alarm is always re-armed before the handler returns (AL1).
 */
export async function runAlarm({ env, ctx, sql, runEntry, push, repush }: AlarmDeps): Promise<void> {
  const now = Date.now();
  for (const timer of timerDue(sql, now)) {
    if (timer.kind === "events") {
      try {
        await deliverEvents(env, ctx);
      } catch {
        rescheduleTimer(sql, timer);
        recordTrunkError(ctx, "timer:events", "timer_failed");
      }
      continue;
    }
    // The shell's own timer kinds run their handler, not an engine entry: `push` is the outbox's
    // retry (9.6), `repush` the heads-up delivery (HU5b).
    const shellWork = timer.kind === "push" ? push : timer.kind === "repush" ? repush : undefined;
    if (shellWork !== undefined) {
      try {
        await shellWork();
      } catch {
        rescheduleTimer(sql, timer);
        recordTrunkError(ctx, `timer:${timer.kind}`, "timer_failed");
      }
      continue;
    }
    sql.transaction(() => timerDelete(sql, timer.kind, timer.key));
    try {
      const ran = await runEntry(timer.kind, { timer });
      if (ran) {
        sql.transaction(() => sql.exec("DELETE FROM meta WHERE k = ?", `timer_fails:${timer.kind}:${timer.key}`));
      } else {
        rescheduleTimer(sql, timer);
        recordTrunkError(ctx, `timer:${timer.kind}`, "timer_unhandled");
      }
    } catch {
      rescheduleTimer(sql, timer);
      recordTrunkError(ctx, `timer:${timer.kind}`, "timer_failed");
    }
  }
  await armAlarm(ctx, sql);
}
