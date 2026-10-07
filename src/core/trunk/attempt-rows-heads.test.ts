import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { persistHeadsUps } from "./attempt-rows.ts";
import { Trunk } from "./registry.ts";
import type { Attempt, Head } from "./sets.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(summaryOnly = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const writes: Array<{ query: string; bindings: unknown[]; rows: number }> = [];
  const sql: Sql = {
    exec(query, ...bindings) {
      const before = changes();
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      const changed = changes() - before;
      if (changed > 0) writes.push({ query, bindings, rows: changed });
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
      "creatures/seed.js": "export const energy = 1;\n",
    },
    { now: () => 1_000, summary_only: summaryOnly },
  );
  trunk.pushOk();
  trunk.openAttempt("observer", { intent: "Read the pool" });
  const observer = trunk.pool.attempts.get("observer")!;
  let calls = 0;
  const call = (id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
    const response = trunk.tool({ attempt_id: id, call_id: `call-${++calls}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  };
  const save = (attempt: Attempt) => sql.transaction(() => persistHeadsUps(sql, attempt));
  const rows = () => sql.exec("SELECT * FROM heads_ups ORDER BY attempt_id, hn").toArray();
  const events = () =>
    sql
      .exec("SELECT n, body FROM events_out ORDER BY n")
      .toArray()
      .map((row): Record<string, unknown> => ({
        ...(JSON.parse(String(row.body)) as Record<string, unknown>),
        n: Number(row.n),
      }));
  writes.length = 0;
  return { db, sql, trunk, observer, call, changes, writes, save, rows, events };
}

function head(attempt_id: string, hn: number): Head {
  return {
    hn,
    result: "info",
    wake: false,
    body: {
      hn,
      attempt_id,
      result: "info",
      wake: false,
      cause: { type: "landing", seqs: [hn], changes: [] },
      items: [],
      dropped_ops: [],
      go_around: null,
      head_seq: hn,
      created_at: 1_000 + hn,
    },
    created_at: 1_000 + hn,
    received_at: null,
    delivered_at: null,
    resolved_at: null,
    statement: null,
    op_mark: 0,
  };
}

describe("differential heads-up persistence", () => {
  it("inserts one new heads-up without rewriting history, including after reopening", () => {
    const { sql, observer, save, rows, changes } = fixture();
    observer.heads = Array.from({ length: 64 }, (_, i) => head(observer.id, i + 1));
    save(observer);
    const historical = rows();
    const reopened = Trunk.open(sql).pool.attempts.get(observer.id)!;
    const before = changes();
    save(reopened);
    expect(changes() - before).toBe(0);
    reopened.heads.push(head(observer.id, 65));
    save(reopened);
    expect(changes() - before).toBe(1);
    expect(rows().slice(0, 64)).toEqual(historical);
    expect(Trunk.open(sql).pool.attempts.get(observer.id)!.heads).toEqual(reopened.heads);
  });

  it("updates only the changed row and persists every mutable heads-up field", () => {
    const { observer, save, rows, changes, writes } = fixture();
    observer.heads = [head(observer.id, 1), head(observer.id, 2)];
    save(observer);
    const untouched = rows()[0];
    const changed = observer.heads[1]!;
    changed.result = "confirm";
    changed.wake = true;
    changed.body = { ...changed.body, result: "confirm", wake: true, head_seq: 3 };
    changed.created_at = 2_000;
    changed.received_at = 2_100;
    changed.delivered_at = 2_200;
    changed.resolved_at = 2_300;
    changed.statement = "The new shared value is valid.";
    changed.op_mark = 4;
    writes.length = 0;
    const before = changes();
    save(observer);
    expect(changes() - before).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.query.startsWith("UPDATE heads_ups")).toBe(true);
    expect(rows()[0]).toEqual(untouched);
    expect(rows()[1]).toEqual({
      attempt_id: observer.id,
      hn: 2,
      result: "confirm",
      wake: 1,
      body: JSON.stringify(changed.body),
      created_at: 2_000,
      received_at: 2_100,
      delivered_at: 2_200,
      resolved_at: 2_300,
      statement: "The new shared value is valid.",
      op_mark: 4,
    });
  });

  it("deletes only removed heads-ups and preserves another attempt with the same number", () => {
    const { trunk, observer, save, rows, changes } = fixture();
    observer.heads = [head(observer.id, 1), head(observer.id, 2), head(observer.id, 3)];
    save(observer);
    trunk.openAttempt("other", { intent: "Keep another history" });
    const other = trunk.pool.attempts.get("other")!;
    other.heads.push(head(other.id, 2));
    save(other);
    const beforeRows = rows();
    observer.heads.splice(1, 1);
    const before = changes();
    save(observer);
    expect(changes() - before).toBe(1);
    expect(rows()).toEqual(beforeRows.filter((row) => row.attempt_id !== observer.id || row.hn !== 2));
  });

  it("reads SQLite again after rollback so a retry persists all pending changes", () => {
    const { sql, observer, save, rows, changes } = fixture();
    observer.heads.push(head(observer.id, 1));
    save(observer);
    const beforeRows = rows();
    observer.heads[0]!.received_at = 2_000;
    observer.heads.push(head(observer.id, 2));
    expect(() =>
      sql.transaction(() => {
        persistHeadsUps(sql, observer);
        throw new Error("rollback witness");
      }),
    ).toThrow("rollback witness");
    expect(rows()).toEqual(beforeRows);
    const before = changes();
    save(observer);
    expect(changes() - before).toBe(2);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.received_at).toBe(2_000);
  });
});

describe("post-batch attempt persistence", () => {
  it("does not rewrite an unaffected attempt or its heads-up history", () => {
    const { sql, trunk, observer, call, save, rows, writes, events } = fixture();
    call(observer.id, "read", { path: "GUIDE.md" });
    observer.heads = [head(observer.id, 1), head(observer.id, 2)];
    save(observer);
    trunk.openAttempt("writer", { intent: "Add a creature" });
    call("writer", "write", { path: "creatures/new.js", content: "export const energy = 2;\n" });
    expect(call("writer", "submit", { summary: "Add creature" }).result).toMatchObject({ status: "validated" });
    const beforeAttempt = sql.exec("SELECT * FROM attempts WHERE attempt_id = ?", observer.id).toArray();
    const beforeHeads = rows();
    const beforeJudgments = sql.exec("SELECT * FROM judgments WHERE attempt_id = ?", observer.id).toArray();
    const firstEvent = trunk.pool.eventCounter;
    writes.length = 0;
    trunk.pool.now = () => 2_000;
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["writer"]);
    expect(
      writes.filter(
        (write) =>
          /(?:INTO|UPDATE|FROM) (?:attempts|heads_ups)\b/.test(write.query) && write.bindings.includes(observer.id),
      ),
    ).toEqual([]);
    expect(sql.exec("SELECT * FROM attempts WHERE attempt_id = ?", observer.id).toArray()).toEqual(beforeAttempt);
    expect(rows()).toEqual(beforeHeads);
    expect(sql.exec("SELECT * FROM judgments WHERE attempt_id = ?", observer.id).toArray()).toEqual(beforeJudgments);
    expect(events().filter((event) => Number(event.n) >= firstEvent && event.attempt_id === observer.id)).toEqual([]);
  });

  it("JE1: still persists a holds judgment, its event, and the changed listing pin", () => {
    const { sql, trunk, observer, call, events } = fixture();
    call(observer.id, "list", { path: "creatures/" });
    const pinned = observer.premises.get("listing|creatures/")!.hash;
    trunk.openAttempt("writer", { intent: "Add a creature" });
    call("writer", "write", { path: "creatures/new.js", content: "export const energy = 2;\n" });
    expect(call("writer", "submit", { summary: "Add creature" }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["writer"]);
    expect(sql.exec("SELECT rule, result FROM judgments WHERE attempt_id = ?", observer.id).toArray()).toEqual([
      { rule: "L3", result: "holds" },
    ]);
    expect(
      events().filter((event) => event.type === "premise.judged" && event.attempt_id === observer.id),
    ).toMatchObject([{ rule: "L3", result: "holds" }]);
    const reopened = Trunk.open(sql).pool.attempts.get(observer.id)!;
    expect(reopened.premises.get("listing|creatures/")).toMatchObject({
      members: ["new.js", "seed.js"],
      seq: 1,
      status: "holds",
    });
    expect(reopened.premises.get("listing|creatures/")!.hash).not.toBe(pinned);
  });

  it("JE1: a summary-only pool stores a holds judgment without a heads-up or judgment event", () => {
    const { sql, trunk, observer, call, events } = fixture(true);
    call(observer.id, "list", { path: "creatures/" });
    trunk.openAttempt("writer", { intent: "Add a creature" });
    call("writer", "write", { path: "creatures/new.js", content: "export const energy = 2;\n" });
    expect(call("writer", "submit", { summary: "Add creature" }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["writer"]);
    expect(sql.exec("SELECT rule, result FROM judgments WHERE attempt_id = ?", observer.id).toArray()).toEqual([
      { rule: "L3", result: "holds" },
    ]);
    expect(observer.heads).toEqual([]);
    expect(
      events().filter(
        (event) =>
          event.attempt_id === observer.id && (event.type === "premise.judged" || event.type === "headsup.sent"),
      ),
    ).toEqual([]);
    expect(Trunk.open(sql).pool.attempts.get(observer.id)!.premises.get("listing|creatures/")).toMatchObject({
      members: ["new.js", "seed.js"],
      seq: 1,
      status: "holds",
    });
  });
});
