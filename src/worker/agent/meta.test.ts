import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema, metaDelete, metaGet, metaSet as storeMetaSet } from "../../core/agent/store.ts";
import type { Sql } from "../../protocol/ports.ts";
import { metaSet } from "./meta.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let writes = 0;
  let statements = 0;
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const sql: Sql = {
    exec: (query, ...bindings) => {
      const before = changes();
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      writes += changes() - before;
      if (/^(INSERT|UPDATE|DELETE)\b/i.test(query)) statements += 1;
      return { toArray: () => rows };
    },
    transaction: (run) => {
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
  applySchema(sql);
  return {
    sql,
    count: () => ({ writes, statements }),
    reset: () => {
      writes = 0;
      statements = 0;
    },
  };
}

describe("Agent meta writes", () => {
  it("writes a new or changed value once and skips an unchanged value", () => {
    const { sql, count, reset } = fixture();
    metaSet(sql, "state", "working");
    expect(count()).toEqual({ writes: 1, statements: 1 });
    expect(metaGet(sql, "state")).toBe("working");

    reset();
    metaSet(sql, "state", "working");
    expect(count()).toEqual({ writes: 0, statements: 0 });

    metaSet(sql, "state", "validated");
    expect(count()).toEqual({ writes: 1, statements: 1 });
    expect(metaGet(sql, "state")).toBe("validated");
  });

  it("compares counters as stored strings and preserves empty strings", () => {
    const { sql, count, reset } = fixture();
    metaSet(sql, "step", 0);
    metaSet(sql, "statement", "");
    reset();
    sql.transaction(() => {
      metaSet(sql, "step", "0");
      metaSet(sql, "statement", "");
    });
    expect(count()).toEqual({ writes: 0, statements: 0 });
    expect(metaGet(sql, "step")).toBe("0");
    expect(metaGet(sql, "statement")).toBe("");
  });

  it("observes changes and deletion made by another writer", () => {
    const { sql, count, reset } = fixture();
    metaSet(sql, "state", "working");
    storeMetaSet(sql, "state", "validated");
    reset();
    metaSet(sql, "state", "working");
    expect(count()).toEqual({ writes: 1, statements: 1 });
    expect(metaGet(sql, "state")).toBe("working");

    metaDelete(sql, "state");
    reset();
    metaSet(sql, "state", "working");
    expect(count()).toEqual({ writes: 1, statements: 1 });
    expect(metaGet(sql, "state")).toBe("working");
  });

  it("retries a value after its transaction rolled back", () => {
    const { sql, count, reset } = fixture();
    metaSet(sql, "state", "working");
    expect(() =>
      sql.transaction(() => {
        metaSet(sql, "state", "validated");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(metaGet(sql, "state")).toBe("working");

    reset();
    sql.transaction(() => metaSet(sql, "state", "validated"));
    expect(count()).toEqual({ writes: 1, statements: 1 });
    expect(metaGet(sql, "state")).toBe("validated");
  });
});
