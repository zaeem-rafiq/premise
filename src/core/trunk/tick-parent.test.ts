import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { Trunk } from "./registry.ts";
import { metaGet, metaSet } from "./schema.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
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
  const trunk = Trunk.create(sql, { ".premise/policy.json": '{"v":1,"default":"auto"}' }, { now: () => 1_000 });
  trunk.pushOk();
  const submit = (id: string) => {
    trunk.openAttempt(id, { intent: `Add ${id}` });
    expect(
      trunk.tool({
        attempt_id: id,
        call_id: `${id}-write`,
        tool: "write",
        args: { path: `${id}.txt`, content: id },
        ack: 0,
      }).ok,
    ).toBe(true);
    expect(
      trunk.tool({ attempt_id: id, call_id: `${id}-submit`, tool: "submit", args: { summary: `Add ${id}` }, ack: 0 })
        .result,
    ).toMatchObject({ status: "validated" });
  };
  // Compare all durable accept-transaction side effects, not only the outbox row.
  const snapshot = () =>
    [
      "meta",
      "attempts",
      "landings",
      "landing_files",
      "landing_writes",
      "landing_premises",
      "landing_ops",
      "files",
      "trees",
      "blobs",
      "outbox",
      "outbox_chunks",
      "events_out",
      "timers",
    ].map((table) => sql.exec(`SELECT * FROM ${table}`).toArray());
  return { sql, trunk, submit, snapshot };
}

describe("the batch parent assertion", () => {
  it.each(["head_commit", "notes_commit"])("rejects stale %s without persisting any acceptance", (key) => {
    const { sql, trunk, submit, snapshot } = fixture();
    submit("a");
    // A retained facade missed a newer durable head. The expected refusal is LP4's
    // compare-and-swap contract, not a value computed by the batch under test.
    metaSet(sql, key, "a".repeat(40));
    const before = snapshot();
    expect(() => trunk.tick()).toThrow("batch parent differs from SQLite head");
    expect(snapshot()).toEqual(before);
    expect(Trunk.open(sql).state("a")).toBe("validated");
  });

  it("rejects a stale landing chain even when both cached refs match SQLite", () => {
    const { sql, trunk, submit, snapshot } = fixture();
    submit("a");
    trunk.tick();
    trunk.pushOk();
    submit("b");
    trunk.pool.landings[0]!.commit_oid = "b".repeat(40);
    const before = snapshot();
    expect(() => trunk.tick()).toThrow("batch parent differs from SQLite head");
    expect(snapshot()).toEqual(before);
    expect(Trunk.open(sql).state("b")).toBe("validated");
  });

  it("refuses to replace SQLite's unpushed batch when the cached outbox is missing", () => {
    const { sql, trunk, submit, snapshot } = fixture();
    submit("a");
    trunk.tick();
    submit("b");
    trunk.pool.outbox = null;
    const before = snapshot();
    expect(() => trunk.tick()).toThrow("batch would replace an unpushed SQLite outbox");
    expect(snapshot()).toEqual(before);
    expect(Trunk.open(sql).state("a")).toBe("accepted");
    expect(Trunk.open(sql).state("b")).toBe("validated");
  });

  it("builds successive batches from SQLite's head and notes after each push", () => {
    const { sql, trunk, submit } = fixture();
    for (const id of ["a", "b"]) {
      submit(id);
      const old_main = metaGet(sql, "head_commit");
      const old_notes = metaGet(sql, "notes_commit");
      trunk.tick();
      expect(sql.exec("SELECT old_main, old_notes FROM outbox").toArray()).toEqual([{ old_main, old_notes }]);
      trunk.pushOk();
    }
    expect(sql.exec("SELECT COUNT(*) AS n FROM landings WHERE pushed_at IS NOT NULL").toArray()).toEqual([{ n: 2 }]);
  });
});
