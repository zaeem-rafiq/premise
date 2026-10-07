import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { releaseWorkingState, Trunk } from "../../src/core/trunk/registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(mode: "retained" | "released" | "reopened") {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...values) {
      const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
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
  const options = { now: () => 1_000, constants: { STARVATION_AFTER: 99 } };
  const retained = Trunk.create(
    sql,
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "world.js": "export const MAX_SPEED = 2;\n",
    },
    options,
  );
  retained.pushOk();
  if (mode === "released") releaseWorkingState(retained.pool);
  const engine = () => (mode === "reopened" ? Trunk.open(sql, options) : retained);
  function run<T>(call: (trunk: Trunk) => T): T {
    const trunk = engine();
    const result = call(trunk);
    if (mode === "released") releaseWorkingState(trunk.pool);
    return result;
  }
  let n = 0;
  function tool(attempt_id: string, name: ToolRequest["tool"], args: ToolRequest["args"], ack = 0) {
    const response = run((trunk) => trunk.tool({ attempt_id, call_id: `call-${++n}`, tool: name, args, ack }));
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  function edit(id: string, before: number, after: number, ack = 0) {
    tool(id, "read", { path: "world.js", entity: "MAX_SPEED" }, ack);
    tool(id, "replace", { path: "world.js", old: `MAX_SPEED = ${before}`, new: `MAX_SPEED = ${after}` }, ack);
    expect(
      tool(id, "submit", { summary: `Set speed to ${after}`, ...(ack === 0 ? {} : { acknowledge: [ack] }) }, ack)
        .result,
    ).toMatchObject({ status: "validated" });
  }
  function secondRepair(sameIntent: boolean) {
    // C17/C54: first repair, delivered and acknowledged, then another E1 on the same
    // entity. IDs keep the competing landing first even when validation times tie (LP2).
    run((trunk) => trunk.openAttempt("z-repair", { intent: "Set speed to 10", intent_id: "i_target" }));
    run((trunk) => trunk.openAttempt("a-first", { intent: "Raise speed to 3", intent_id: "i_first" }));
    edit("a-first", 2, 3);
    edit("z-repair", 2, 10);
    run((trunk) => trunk.tick());
    run((trunk) => trunk.pushOk());
    expect(engine().pool.attempts.get("z-repair")).toMatchObject({
      state: "going_around",
      stop_reason: null,
      go_arounds: 1,
    });
    expect(
      sql.exec("SELECT rule, result FROM judgments WHERE attempt_id = ? AND rule = 'E1'", "z-repair").toArray(),
    ).toEqual([{ rule: "E1", result: "repair" }]);

    run((trunk) =>
      trunk.openAttempt("b-second", {
        intent: sameIntent ? "Set speed to 10" : "Raise speed to 4",
        intent_id: sameIntent ? "i_target" : "i_second",
      }),
    );
    edit("b-second", 3, 4);
    edit("z-repair", 3, 10, 1);
    run((trunk) => trunk.tick());
    const pool = engine().pool;
    expect(
      sql.exec("SELECT rule, result FROM judgments WHERE attempt_id = ? AND rule = 'E1'", "z-repair").toArray(),
    ).toEqual([
      { rule: "E1", result: "repair" },
      { rule: "E1", result: "repair" },
    ]);
    return pool;
  }
  return { secondRepair };
}

describe.each(["retained", "released", "reopened"] as const)("GL3 historical E1 repairs with %s state", (mode) => {
  it("stops on a second repair from another intent and opens the contradiction choice", () => {
    const pool = fixture(mode).secondRepair(false);
    expect(pool.attempts.get("z-repair")).toMatchObject({
      state: "stopped",
      stop_reason: "contradiction",
      go_arounds: 1,
    });
    expect(pool.cards.filter((card) => card.open)).toMatchObject([
      { kind: "choice", reason: "contradiction", attempt_ids: ["z-repair", "b-second"] },
    ]);
  });

  it("keeps a second repair from its own intent as an ordinary go-around", () => {
    const pool = fixture(mode).secondRepair(true);
    expect(pool.attempts.get("z-repair")).toMatchObject({
      state: "going_around",
      stop_reason: null,
      go_arounds: 2,
    });
    expect(pool.cards.filter((card) => card.open)).toEqual([]);
  });
});
