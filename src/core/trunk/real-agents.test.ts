// src/core/trunk/real-agents.test.ts — `pool.state.real_agents` (01-core.md EM1 and 12.1,
// 05-agent MG5 and 4.5): the number of the pool's `real` attempts whose Agent's loop runs —
// `working`, `going_around` or `needs_confirm`. An `opened` attempt may still wait for a
// slot; `submitted`, `validated`, `held` and `accepted` wait; synthetic attempts never count.
// Every transition that moves the number updates `meta` inside its transaction and emits
// `pool.state` again — at most once per transaction.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { poolStateBody } from "./events.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const seed = {
  ".premise/policy.json": '{"v":1,"default":"auto"}',
  "world.js": "export const LIMIT = 100;\n",
};

function fixture() {
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
  let now = 1_000;
  let n = 0;
  const trunk = Trunk.create(sql, seed, { features: { held: true }, now: () => now });
  trunk.pushOk();
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"], engine = trunk) {
    const response = engine.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  return { trunk, sql, call };
}

const realAgents = (sql: Sql): number =>
  Number(sql.exec("SELECT v FROM meta WHERE k = 'real_agents'").toArray()[0]?.v ?? "0");

const poolStates = (sql: Sql): Array<Record<string, unknown>> =>
  sql
    .exec("SELECT body FROM events_out ORDER BY n")
    .toArray()
    .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>)
    .filter((body) => body.type === "pool.state");

const lastRealAgents = (sql: Sql): number => {
  const states = poolStates(sql);
  return Number(states[states.length - 1]?.real_agents ?? -1);
};

describe("pool.state.real_agents (EM1, 05-agent MG5 and 4.5)", () => {
  it("tracks the real attempts whose Agent's loop runs and re-emits pool.state once a call", () => {
    const { trunk, sql, call } = fixture();
    // B validates first, so the tick lands its change and sends A's repair heads-up (T8).
    trunk.openAttempt("B", { intent: "Raise the limit", agent_kind: "real" });
    // `opened` does not count — the attempt may still wait for a real-agent slot (MG5).
    expect(realAgents(sql)).toBe(0);

    // T1: the first tool call moves the attempt to `working` — the loop runs.
    call("B", "read", { path: "world.js" });
    expect(realAgents(sql)).toBe(1);
    expect(lastRealAgents(sql)).toBe(1);

    call("B", "replace", { path: "world.js", old: "100", new: "5" });
    const beforeSubmit = poolStates(sql).length;
    expect(call("B", "submit", { summary: "Raise LIMIT to five" }).result).toMatchObject({
      status: "validated",
    });
    // `validated` waits on the landing queue — the loop is not running.
    expect(realAgents(sql)).toBe(0);
    expect(lastRealAgents(sql)).toBe(0);
    expect(poolStates(sql).length).toBe(beforeSubmit + 1);

    trunk.openAttempt("A", { intent: "Lower the limit", agent_kind: "real" });
    call("A", "read", { path: "world.js" });
    expect(realAgents(sql)).toBe(1);
    call("A", "replace", { path: "world.js", old: "100", new: "1" });
    call("A", "submit", { summary: "Lower LIMIT to one" });
    expect(trunk.state("A")).toBe("validated");
    expect(realAgents(sql)).toBe(0);

    // T8: B's landing sends A back on a go-around — the loop runs again.
    trunk.tick();
    expect(trunk.state("A")).toBe("going_around");
    expect(realAgents(sql)).toBe(1);
    expect(lastRealAgents(sql)).toBe(1);

    // TA9 `stop`: the loop ends.
    expect(trunk.stop({ attempt_id: "A", reason: "done" })).toMatchObject({ ok: true });
    expect(trunk.state("A")).toBe("stopped");
    expect(realAgents(sql)).toBe(0);
    expect(lastRealAgents(sql)).toBe(0);
  });

  it("never counts a synthetic attempt", () => {
    const { trunk, sql, call } = fixture();
    trunk.openAttempt("SYN", { intent: "Synthetic work", agent_kind: "synthetic" });
    const emitted = poolStates(sql).length;
    call("SYN", "read", { path: "world.js" });
    expect(trunk.state("SYN")).toBe("working");
    expect(realAgents(sql)).toBe(0);
    // The count never moved — the call emits no `pool.state` (EM1).
    expect(poolStates(sql).length).toBe(emitted);
    call("SYN", "submit", { summary: "Synthetic done" });
    expect(realAgents(sql)).toBe(0);
    expect(lastRealAgents(sql)).toBe(0);
  });

  it("survives a pool reopen over the same store", () => {
    const { trunk, sql, call } = fixture();
    trunk.openAttempt("A", { intent: "Lower the limit", agent_kind: "real" });
    call("A", "read", { path: "world.js" });
    expect(realAgents(sql)).toBe(1);
    const reopened = Trunk.open(sql, { features: { held: true } });
    expect(poolStateBody(reopened.pool).real_agents).toBe(1);
  });
});
