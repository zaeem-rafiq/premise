// The alarm handler's claim on a due timer (AL1). The handler lists the due timers once, then
// awaits each one's work in turn. A row rewritten during one of those awaits - a push that was
// already in flight schedules its retry - is no longer the row the list saw: the handler must
// leave it in place, not delete it as consumed. The defect this pins: the refused-push test of
// test/workerd/landing/defects.test.ts failed with the outbox waiting for a retry
// (`tries: 1`, `next_try` set) and an empty `timers` table, so the pool never pushed again.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { runAlarm } from "./alarm.ts";
import { applyShellSchema, timerGetDue, timerPut } from "./sql.ts";

/** `node:sqlite` speaking the `Sql` port, in place of the Durable Object's storage. */
function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const r = run();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/** The storage calls `armAlarm` makes; nothing else of the object is used. */
function fakeCtx(): { ctx: DurableObjectState; alarmAt: () => number | null } {
  let at: number | null = null;
  const storage = {
    setAlarm: async (when: number) => {
      at = when;
    },
    deleteAlarm: async () => {
      at = null;
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, alarmAt: () => at };
}

const NOW = 1_000_000;

describe("runAlarm (AL1)", () => {
  it("leaves a timer that was rescheduled while an earlier timer's work ran", async () => {
    const sql = memorySql();
    applyShellSchema(sql);
    const { ctx, alarmAt } = fakeCtx();
    // Two due timers: the heads-up delivery first, then the push.
    timerPut(sql, "repush", "a_1", NOW - 20);
    timerPut(sql, "push", "", NOW - 10);
    const pushes: number[] = [];

    await runAlarm({
      env: {} as Env,
      ctx,
      sql,
      now: NOW,
      runEntry: async () => true,
      // While the heads-up delivery awaits, the push that was in flight is refused and
      // schedules its retry: the `push` row now names a time that has not come.
      repush: async () => {
        timerPut(sql, "push", "", NOW + 500);
      },
      push: async (at) => {
        pushes.push(at);
      },
    });

    expect(pushes).toEqual([]);
    expect(timerGetDue(sql, "push", "")).toBe(NOW + 500);
    expect(alarmAt()).toBe(NOW + 500);
  });

  it("still runs and consumes a timer that stayed due", async () => {
    const sql = memorySql();
    applyShellSchema(sql);
    const { ctx, alarmAt } = fakeCtx();
    timerPut(sql, "push", "", NOW - 10);
    const pushes: number[] = [];

    await runAlarm({
      env: {} as Env,
      ctx,
      sql,
      now: NOW,
      runEntry: async () => true,
      push: async (at) => {
        pushes.push(at);
      },
    });

    expect(pushes).toEqual([NOW]);
    expect(timerGetDue(sql, "push", "")).toBeNull();
    expect(alarmAt()).toBeNull();
  });
});
