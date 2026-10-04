// src/core/agent/store.test.ts — the row helpers over a real SQLite store
// (node:sqlite stands in for the Durable Object's sql; both speak the Sql
// port). These cover the shapes AG1, HU4 and AL1 depend on.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import {
  applySchema,
  inboxBodies,
  inboxHns,
  inboxMarkShown,
  inboxPut,
  journalDelete,
  journalGet,
  journalPut,
  journalRetry,
  metaGet,
  metaSet,
  timerDue,
  timerMin,
  timerPut,
  transcriptAppend,
  transcriptRows,
} from "./store.ts";

function sqlOver(db: DatabaseSync): Sql {
  return {
    exec: (query, ...bindings) => {
      const stmt = db.prepare(query);
      const rows = /^\s*(select|with|pragma)/i.test(query)
        ? (stmt.all(...(bindings as never[])) as Record<string, unknown>[])
        : (stmt.run(...(bindings as never[])), [] as Record<string, unknown>[]);
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const out = run();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function fresh(): Sql {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  applySchema(sql);
  return sql;
}

describe("the Agent store helpers", () => {
  it("meta set/get round-trips strings and numbers", () => {
    const sql = fresh();
    metaSet(sql, "state", "working");
    metaSet(sql, "shown_hn", 3);
    expect(metaGet(sql, "state")).toBe("working");
    expect(metaGet(sql, "shown_hn")).toBe("3");
    expect(metaGet(sql, "absent")).toBeNull();
  });

  it("AG1: the journal holds at most one row and deletes cleanly", () => {
    const sql = fresh();
    journalPut(sql, {
      kind: "tool",
      call_id: "a_x:1",
      request: { tool: "list" },
      tries: 0,
      started_at: 10,
      deadline_at: 20,
    });
    const j = journalGet(sql);
    expect(j?.call_id).toBe("a_x:1");
    expect(j?.tries).toBe(0);
    journalRetry(sql, 30);
    expect(journalGet(sql)?.tries).toBe(1);
    expect(journalGet(sql)?.deadline_at).toBe(30);
    journalDelete(sql);
    expect(journalGet(sql)).toBeNull();
  });

  it("HU4: inboxPut de-duplicates by hn", () => {
    const sql = fresh();
    expect(inboxPut(sql, 1, { hn: 1 }, 100)).toBe(true);
    expect(inboxPut(sql, 1, { hn: 1 }, 200)).toBe(false);
    expect(inboxPut(sql, 3, { hn: 3 }, 100)).toBe(true);
    expect(inboxHns(sql)).toEqual([1, 3]);
    expect(inboxBodies<{ hn: number }>(sql, [1, 3])).toEqual([{ hn: 1 }, { hn: 3 }]);
    inboxMarkShown(sql, [1], 4);
    sql.transaction(() => inboxHns(sql));
  });

  it("transcript rows append in step order", () => {
    const sql = fresh();
    for (const step of [1, 2]) {
      transcriptAppend(sql, {
        step,
        role: "tool",
        content: "{}",
        tool: "list",
        call_id: `a_x:${step}`,
        model: null,
        tokens_in: null,
        tokens_out: null,
        started_at: 1,
        ended_at: 2,
      });
    }
    expect(transcriptRows(sql).map((r) => r.step)).toEqual([1, 2]);
  });

  it("AL1: timers list by due_at; timerMin and timerDue agree", () => {
    const sql = fresh();
    timerPut(sql, "watchdog", "main", 300);
    timerPut(sql, "call", "a_x:1", 100);
    timerPut(sql, "call", "a_x:2", 200);
    expect(timerMin(sql)).toBe(100);
    expect(timerDue(sql, 150).map((t) => t.key)).toEqual(["a_x:1"]);
    timerPut(sql, "call", "a_x:1", 400); // reschedule moves the row
    expect(timerMin(sql)).toBe(200);
  });
});
