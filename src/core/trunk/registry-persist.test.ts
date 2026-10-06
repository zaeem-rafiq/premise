import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRequest } from "../../protocol/tools.ts";
import type { Sql } from "../../protocol/ports.ts";
import { Trunk } from "./registry.ts";
import { metaGet, metaSet } from "./schema.ts";
import { persistPremises, persistOps } from "./attempt-rows.ts";
import { metaWrite } from "./events.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const writes: Array<{ query: string; rows: number }> = [];
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const sql: Sql = {
    exec(query, ...bindings) {
      const before = changes();
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      const changed = changes() - before;
      if (changed > 0) writes.push({ query, rows: changed });
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
  const trunk = Trunk.create(
    sql,
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "GUIDE.md": "# Pool\n",
      "README.md": "# More context\n",
    },
    { now: () => 1_000 },
  );
  trunk.pushOk();
  writes.length = 0;
  const rowsFor = (table: string) =>
    writes
      .filter((write) => new RegExp(`(?:INTO|UPDATE|FROM) ${table}\\b`).test(write.query))
      .reduce((n, write) => n + write.rows, 0);
  return { db, sql, trunk, writes, rowsFor };
}

describe("Trunk persistence", () => {
  it("a tool call writes two meta rows at both 1 and 200 attempts", () => {
    const counts = [1, 200].map((size) => {
      const { sql, trunk, writes, rowsFor } = fixture();
      let n = 0;
      const call = (engine: Trunk, attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
        const result = engine.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        return result;
      };
      for (let i = 0; i < size; i += 1) {
        const id = `a-${i}`;
        trunk.openAttempt(id, { intent: `Add creature ${i}` });
        call(trunk, id, "read", { path: "GUIDE.md" });
        call(trunk, id, "write", { path: `creatures/c${i}.js`, content: `export const energy = ${i};\n` });
        expect(call(trunk, id, "submit", { summary: `Creature ${i}` }).result).toMatchObject({ status: "validated" });
      }
      // Populate real steps/checks keys through tools, then use the production reopen path.
      const reopened = Trunk.open(sql, { now: () => 2_000 });
      writes.length = 0;
      call(reopened, "a-0", "read", { path: "GUIDE.md" });
      expect(rowsFor("premises")).toBe(0);
      expect(rowsFor("ops")).toBe(0);
      const metaWrites = writes.filter((write) => /(?:INTO|UPDATE|FROM) meta\b/.test(write.query));
      // One step counter and one event counter. No other attempt's metadata changes.
      expect(metaWrites).toHaveLength(2);
      return rowsFor("meta");
    });
    expect(counts).toEqual([2, 2]);
  });

  it("a read adding one premise writes exactly one premise row", () => {
    const { sql, trunk, writes, rowsFor } = fixture();
    trunk.openAttempt("a", { intent: "Read the guide" });
    expect(trunk.tool({ attempt_id: "a", call_id: "one", tool: "read", args: { path: "GUIDE.md" }, ack: 0 }).ok).toBe(
      true,
    );
    const reopened = Trunk.open(sql);
    writes.length = 0;
    expect(
      reopened.tool({ attempt_id: "a", call_id: "two", tool: "read", args: { path: "README.md" }, ack: 0 }).ok,
    ).toBe(true);
    expect(rowsFor("premises")).toBe(1);
    const premiseWrites = writes.filter((write) => /(?:INTO|UPDATE|FROM) premises\b/.test(write.query));
    expect(premiseWrites).toHaveLength(1);
    expect(premiseWrites[0]!.query.startsWith("INSERT INTO premises")).toBe(true);
    expect(Trunk.open(sql).pool.attempts.get("a")!.premises.size).toBe(2);
  });

  it("advances the saved meta only after a successful transaction", () => {
    const { db, sql, trunk, writes, rowsFor } = fixture();
    trunk.pool.meta.set("scratch", "one");
    db.exec(
      "CREATE TRIGGER reject_meta BEFORE INSERT ON meta WHEN NEW.k = 'scratch' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect(() => trunk.tick()).toThrow("test failure");
    expect(metaGet(sql, "scratch")).toBeNull();
    db.exec("DROP TRIGGER reject_meta");
    writes.length = 0;
    trunk.tick();
    expect(metaGet(sql, "scratch")).toBe("one");
    expect(rowsFor("meta")).toBe(1);
  });

  it("inserts, updates and deletes only changed premise and operation rows", () => {
    const { sql, trunk, writes, rowsFor } = fixture();
    trunk.openAttempt("a", { intent: "Read and write" });
    const attempt = trunk.pool.attempts.get("a")!;
    attempt.premises.set("file|GUIDE.md", {
      kind: "file",
      key: "GUIDE.md",
      hash: "before",
      seq: 0,
      members: null,
      shown: null,
      read: true,
      edit: false,
      derived: false,
      status: "holds",
    });
    attempt.ops.push({
      op_seq: 1,
      op: "write",
      path: "GUIDE.md",
      content: "# New",
      base_oid: "absent",
      dropped: false,
    });
    attempt.premises.set("listing|creatures/", {
      kind: "listing",
      key: "creatures/",
      hash: "names",
      seq: 0,
      members: ["crab.js"],
      shown: ["crab.js"],
      read: true,
      edit: false,
      derived: false,
      status: "holds",
    });
    attempt.ops.push({
      op_seq: 2,
      op: "replace",
      path: "world/energy.js",
      old: "100",
      new: "110",
      targets: ["world/energy.js#ENERGY_MAX"],
      dropped: false,
    });
    const save = () =>
      sql.transaction(() => {
        persistPremises(sql, attempt);
        persistOps(sql, attempt);
      });
    writes.length = 0;
    save();
    expect(rowsFor("premises")).toBe(2);
    expect(rowsFor("ops")).toBe(2);
    writes.length = 0;
    save();
    expect(writes).toEqual([]);
    attempt.premises.get("file|GUIDE.md")!.status = "pending_repair";
    attempt.ops[0]!.dropped = true;
    save();
    expect(rowsFor("premises")).toBe(1);
    expect(rowsFor("ops")).toBe(1);
    expect(writes.every((write) => write.query.startsWith("UPDATE"))).toBe(true);
    const loaded = Trunk.open(sql).pool.attempts.get("a")!;
    expect(loaded.premises.get("file|GUIDE.md")!.status).toBe("pending_repair");
    expect(loaded.ops[0]!.dropped).toBe(true);
    expect(loaded.ops[1]).toEqual(attempt.ops[1]);
    expect(loaded.premises.get("listing|creatures/")).toEqual(attempt.premises.get("listing|creatures/"));
    writes.length = 0;
    sql.transaction(() => {
      persistPremises(sql, loaded);
      persistOps(sql, loaded);
    });
    expect(writes).toEqual([]);
    attempt.premises.delete("file|GUIDE.md");
    attempt.ops.splice(0, 1);
    save();
    expect(rowsFor("premises")).toBe(1);
    expect(rowsFor("ops")).toBe(1);
    expect(sql.exec("SELECT kind, key FROM premises").toArray()).toEqual([{ kind: "listing", key: "creatures/" }]);
    expect(sql.exec("SELECT op_seq FROM ops").toArray()).toEqual([{ op_seq: 2 }]);
  });

  it("writes changed meta, deletes removed meta and preserves store-only keys", () => {
    const { sql, trunk, writes, rowsFor } = fixture();
    trunk.pool.meta.set("scratch", "one");
    trunk.tick();
    expect(rowsFor("meta")).toBe(1);
    writes.length = 0;
    trunk.tick();
    expect(rowsFor("meta")).toBe(0);
    trunk.pool.meta.set("scratch", "two");
    trunk.tick();
    expect(rowsFor("meta")).toBe(1);
    expect(metaGet(sql, "scratch")).toBe("two");
    // Rebuild writes some per-attempt meta directly, outside the working map.
    metaSet(sql, "steps:rebuilt", "3");
    writes.length = 0;
    trunk.pool.meta.delete("scratch");
    trunk.tick();
    expect(rowsFor("meta")).toBe(1);
    expect(metaGet(sql, "scratch")).toBeNull();
    expect(metaGet(sql, "steps:rebuilt")).toBe("3");
    metaWrite(trunk.pool, "cursor", "pending");
    trunk.tick();
    writes.length = 0;
    metaWrite(trunk.pool, "cursor", null);
    trunk.tick();
    expect(rowsFor("meta")).toBe(1);
    expect(metaGet(sql, "cursor")).toBeNull();
    const reopened = Trunk.open(sql);
    writes.length = 0;
    reopened.tick();
    expect(rowsFor("meta")).toBe(0);
  });

  it("does not write through unchanged meta and retries a rolled-back value", () => {
    const { sql, rowsFor } = fixture();
    metaSet(sql, "scratch", 1);
    metaSet(sql, "scratch", "1");
    expect(rowsFor("meta")).toBe(1);
    expect(() =>
      sql.transaction(() => {
        metaSet(sql, "scratch", "two");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(metaGet(sql, "scratch")).toBe("1");
    metaSet(sql, "scratch", "two");
    expect(metaGet(sql, "scratch")).toBe("two");
    expect(rowsFor("meta")).toBe(3);
  });
});
