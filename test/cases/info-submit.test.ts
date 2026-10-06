// HU9, 4.9 and 9.3: only acknowledged confirm/repair heads-ups enter submit identity.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { submitIdOf } from "../../src/core/trunk/submit.ts";
import { TICK_MS } from "../../src/protocol/constants.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";
import { sqlOver } from "./driver.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = sqlOver(db);
  const clock = { now: 1_000 };
  const opts = { now: () => clock.now, syncTriage: ScriptedTriage, constants: { MAX_BATCH: 1 } };
  const trunk = Trunk.create(
    sql,
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
    },
    opts,
  );
  trunk.pushOk();
  let n = 0;
  function call(engine: Trunk, attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const response = engine.tool({
      attempt_id,
      call_id: `call-${++n}`,
      tool,
      args,
      ack: engine.pool.attempts.get(attempt_id)!.heads.length,
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  return { db, sql, clock, opts, trunk, call };
}

describe("info heads-ups and the landing queue", () => {
  it.each([false, true])("keeps F4 info out of submit identity (explicit acknowledgement: %s)", (acknowledge) => {
    const { sql, opts, trunk, call } = fixture();
    trunk.openAttempt("writer", { intent: "Raise the cap" });
    call(trunk, "writer", "read", { path: "world/energy.js" });
    call(trunk, "writer", "replace", { path: "world/energy.js", old: "100", new: "110" });
    expect(call(trunk, "writer", "submit", { summary: "Raise the cap" }).result).toMatchObject({ status: "validated" });
    trunk.openAttempt("reader", { intent: "Add an independent creature", agent_kind: "synthetic", truth: [] });
    call(trunk, "reader", "read", { path: "world/energy.js" });
    call(trunk, "reader", "write", { path: "creatures/crab.js", content: "export const energy = 5;\n" });
    expect(call(trunk, "reader", "submit", { summary: "Add a crab" }).result).toMatchObject({ status: "validated" });
    const id = trunk.pool.attempts.get("reader")!.submit_id;

    trunk.tick();
    expect(trunk.out.accepted).toEqual(["writer"]);
    const reader = trunk.pool.attempts.get("reader")!;
    expect(reader.heads).toHaveLength(1);
    expect(reader.heads[0]).toMatchObject({ result: "info", body: { items: [{ rule: "F4" }] } });
    expect(reader.resolved.size).toBe(0);
    expect(submitIdOf(reader)).toBe(id);
    if (acknowledge) {
      expect(
        call(trunk, "reader", "submit", { summary: "Add a crab", acknowledge: [1], statement: "Seen" }).result,
      ).toMatchObject({ status: "validated", submit_id: id, duplicate: true });
      expect(reader.resolved.size).toBe(0);
      // Also exercise CK1 after an accepted operation takes the reader out of the queue.
      call(trunk, "reader", "write", { path: "creatures/crab.js", content: "export const energy = 6;\n" });
      const changedId = submitIdOf(reader);
      expect(
        call(trunk, "reader", "submit", { summary: "Add a crab", acknowledge: [1], statement: "Seen" }).result,
      ).toMatchObject({ status: "validated", submit_id: changedId });
      expect(reader.resolved.size).toBe(0);
      expect(
        sql
          .exec("SELECT body FROM events_out")
          .toArray()
          .some((row) => JSON.parse(String(row.body)).type === "headsup.resolved"),
      ).toBe(false);
    }
    const storedId = reader.submit_id;
    trunk.pushOk();

    const reopened = Trunk.open(sql, opts);
    expect(reopened.state("reader")).toBe("validated");
    expect(reopened.pool.attempts.get("reader")!.resolved.size).toBe(0);
    expect(submitIdOf(reopened.pool.attempts.get("reader")!)).toBe(storedId);
    reopened.tick();
    expect(reopened.out.accepted).toEqual(["reader"]);
    reopened.pushOk();
    expect(reopened.state("reader")).toBe("landed");
  });

  it("rearms an empty tick while right of way temporarily blocks a validated candidate", () => {
    const { sql, clock, opts, trunk, call } = fixture();
    trunk.openAttempt("holder", { intent: "Use the cap" });
    call(trunk, "holder", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    call(trunk, "holder", "write", {
      path: "creatures/crab.js",
      content: 'import { ENERGY_MAX } from "../world/energy.js";\nexport const energy = ENERGY_MAX;\n',
    });
    // RW3's input: a working attempt already holds right of way.
    sql.exec("UPDATE attempts SET right_of_way_at = ? WHERE attempt_id = ?", clock.now, "holder");
    const reopened = Trunk.open(sql, opts);
    reopened.openAttempt("writer", { intent: "Raise the cap" });
    call(reopened, "writer", "read", { path: "world/energy.js" });
    call(reopened, "writer", "replace", { path: "world/energy.js", old: "100", new: "110" });
    expect(call(reopened, "writer", "submit", { summary: "Raise the cap" }).result).toMatchObject({
      status: "validated",
    });
    // AL1: the alarm claims the row before dispatching the tick.
    sql.exec("DELETE FROM timers WHERE kind = 'tick'");
    reopened.tick();
    expect(reopened.out.accepted).toEqual([]);
    expect(reopened.out.skipped.writer).toBe("right_of_way");
    expect(sql.exec("SELECT due_at FROM timers WHERE kind = 'tick'").toArray()).toEqual([
      { due_at: clock.now + TICK_MS },
    ]);
    reopened.stop({ attempt_id: "holder", reason: "cancelled" });
    clock.now += TICK_MS;
    const next = Trunk.open(sql, opts);
    sql.exec("DELETE FROM timers WHERE kind = 'tick'");
    next.tick();
    expect(next.out.accepted).toEqual(["writer"]);
  });
});
