import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { Trunk } from "../../core/trunk/registry.ts";
import { restoreRebuildBootstrap } from "./event-recovery.ts";
import { appendEvent, metaGet, metaSet, pendingEvents } from "./sql.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(): Sql {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
    transaction(run) {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  Trunk.create(sql, { "creatures/test.js": "export const value = 1;\n" }, { pool_id: "recovered", now: () => 10 });
  sql.exec("DELETE FROM events_out");
  metaSet(sql, "epoch", 2);
  metaSet(sql, "head_seq", 377);
  metaSet(sql, "landed_seq", 377);
  metaSet(sql, "next_event_n", 2);
  appendEvent(sql, 20, {
    ts: 20,
    pool: "recovered",
    src: "trunk",
    type: "trunk.error",
    where: "events",
    code: "transport",
  });
  appendEvent(sql, 30, {
    ts: 30,
    pool: "recovered",
    src: "trunk",
    type: "pool.files",
    files: [{ path: "creatures/test.js", tier: "held" }],
  });
  return sql;
}

describe("RB5 bootstrap recovery", () => {
  it("restores only row 1 from current Trunk state, preserving the epoch, suffix and counter", () => {
    const sql = fixture();
    const suffix = pendingEvents(sql);
    expect(restoreRebuildBootstrap(sql, 2, 1, 40)).toBe(true);
    const rows = pendingEvents(sql);
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3]);
    expect(rows.slice(1)).toEqual(suffix);
    expect(JSON.parse(rows[0]!.body)).toMatchObject({
      type: "pool.state",
      pool: "recovered",
      epoch: 2,
      head_seq: 377,
      landed_seq: 377,
      state: "ready",
      ts: 40,
    });
    expect(metaGet(sql, "epoch")).toBe("2");
    expect(metaGet(sql, "next_event_n")).toBe("4");
    expect(restoreRebuildBootstrap(sql, 2, 1, 50)).toBe(false);
    expect(pendingEvents(sql)).toEqual(rows);
  });

  it.each(["larger prefix", "middle hole", "missing tail", "stale epoch", "later expected"])(
    "does not invent lost history for a %s",
    (fault) => {
      const sql = fixture();
      if (fault === "larger prefix") sql.exec("DELETE FROM events_out WHERE n = 2");
      if (fault === "middle hole") {
        appendEvent(sql, 40, { type: "trunk.error" });
        sql.exec("DELETE FROM events_out WHERE n = 3");
      }
      if (fault === "missing tail") metaSet(sql, "next_event_n", 5);
      const before = pendingEvents(sql);
      expect(
        restoreRebuildBootstrap(sql, fault === "stale epoch" ? 3 : 2, fault === "later expected" ? 2 : 1, 50),
      ).toBe(false);
      expect(pendingEvents(sql)).toEqual(before);
    },
  );
});
