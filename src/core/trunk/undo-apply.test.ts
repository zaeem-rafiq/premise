import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { UNDO_WINDOW } from "../../protocol/constants.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec: (q, ...args) => {
      const rows = db.prepare(q).all(...args) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const r = run();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const trunk = Trunk.create(
    sql,
    {
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
      ".premise/policy.json": JSON.stringify({
        v: 1,
        default: "held",
        tiers: [{ paths: ["creatures/**", "world/**"], tier: "auto" }],
      }),
    },
    { now: () => 1000 },
  );
  trunk.pushOk();
  return { trunk, sql };
}
function land(t: Trunk, id: string, path: string, content: string) {
  t.openAttempt(id, { intent: `add ${id}` });
  if (content.includes("import"))
    t.tool({ attempt_id: id, call_id: `${id}:dependency`, tool: "read", args: { path: "world/energy.js" }, ack: 0 });
  if (t.pool.files.has(path)) t.tool({ attempt_id: id, call_id: `${id}:read`, tool: "read", args: { path }, ack: 0 });
  expect(t.tool({ attempt_id: id, call_id: `${id}:write`, tool: "write", args: { path, content }, ack: 0 }).ok).toBe(
    true,
  );
  expect(t.tool({ attempt_id: id, call_id: `${id}:submit`, tool: "submit", args: { summary: id }, ack: 0 }).ok).toBe(
    true,
  );
  t.tick();
  t.pushOk();
  expect(t.pool.attempts.get(id)?.state).toBe("landed");
}

describe("UN4/UN5 owner undo plans", () => {
  it("returns the public plan and persists the confirmed set and request identity across reopen", () => {
    const { trunk: t, sql } = setup();
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    expect(t.undoPlan(1)).toEqual({
      ok: true,
      plan: { target_seq: 1, reverted: [1], reopened: [], kept_readers: [], repairs: [] },
    });
    const req = { seq: 1, expect_reverted: [1], request_id: "confirm" };
    expect(t.undo(req)).toEqual({ ok: true, request_id: "confirm" });
    const reopened = Trunk.open(sql, { now: () => 1000 });
    expect(reopened.pool.undoQueue[0]).toMatchObject({ requested_by: "owner", reverted: [1] });
    expect(reopened.undo(req)).toEqual({ ok: true, request_id: "confirm" });
    expect(reopened.pool.undoQueue).toHaveLength(1);
    reopened.tick();
    reopened.pushOk();
    expect(Trunk.open(sql).undo(req)).toEqual({ ok: true, request_id: "confirm" });
  });
  it("C53 returns plan_changed with the new plan and queues nothing", () => {
    const { trunk: t } = setup();
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    land(
      t,
      "crab",
      "creatures/crab.js",
      'import { ENERGY_MAX } from "../world/energy.js";\nexport const energy = ENERGY_MAX;\n',
    );
    expect(t.undo({ seq: 1, expect_reverted: [1], request_id: "old-plan" })).toEqual({
      ok: false,
      reason: "plan_changed",
      plan: { target_seq: 1, reverted: [1, 2], reopened: ["crab"], kept_readers: [], repairs: [] },
    });
    expect(t.pool.undoQueue).toHaveLength(0);
    expect(t.pool.landings).toHaveLength(2);
  });
  it("UN4 predicts synchronous triage repairs without changing in-flight attempts", () => {
    const { trunk: t } = setup();
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    t.pool.syncTriage = {
      judgeNow: (input) => ({
        answers: Object.fromEntries(Object.keys(input.premises).map((key) => [key, 1])),
        model: "test",
      }),
    };
    t.openAttempt("reader", { intent: "read the rule", agent_kind: "synthetic" });
    t.tool({
      attempt_id: "reader",
      call_id: "read",
      tool: "read",
      args: { path: "world/energy.js", entity: "ENERGY_MAX" },
      ack: 0,
    });
    t.tool({
      attempt_id: "reader",
      call_id: "write",
      tool: "write",
      args: { path: "creatures/reader.js", content: "export const colour = 'blue';\n" },
      ack: 0,
    });
    const before = JSON.stringify([...t.pool.attempts.get("reader")!.premises]);
    expect(t.undoPlan(1)).toEqual({
      ok: true,
      plan: { target_seq: 1, reverted: [1], reopened: [], kept_readers: [], repairs: ["reader"] },
    });
    expect(JSON.stringify([...t.pool.attempts.get("reader")!.premises])).toBe(before);
    t.undo({ seq: 1, expect_reverted: [1], request_id: "repair" });
    t.tick();
    expect(t.pool.attempts.get("reader")!.heads[0]?.body).toMatchObject({ result: "repair", cause: { type: "undo" } });
  });

  it("a delayed triage answer keeps the undo cause and sequence after reopening the store", () => {
    const { trunk: t, sql } = setup();
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    t.pool.clefOn = true;
    t.openAttempt("reader", { intent: "Read the rule and add a colour", agent_kind: "real" });
    t.tool({
      attempt_id: "reader",
      call_id: "read",
      tool: "read",
      args: { path: "world/energy.js", entity: "ENERGY_MAX" },
      ack: 0,
    });
    t.tool({
      attempt_id: "reader",
      call_id: "write",
      tool: "write",
      args: { path: "creatures/reader.js", content: "export const colour = 'blue';\n" },
      ack: 0,
    });
    t.undo({ seq: 1, expect_reverted: [1], request_id: "delayed" });
    t.tick();
    expect(t.pool.pendingTriage).toHaveLength(1);
    const reopened = Trunk.open(sql, { now: () => 1000 });
    reopened.triage({ attempt: "reader", kind: "entity", key: "world/energy.js#ENERGY_MAX", p: 1 });
    expect(reopened.pool.attempts.get("reader")!.heads.at(-1)?.body).toMatchObject({
      result: "repair",
      cause: { type: "undo", seqs: [2] },
    });
  });

  it("refuses an overlapping confirmation and consumes duplicate legacy requests only once", () => {
    const { trunk: t } = setup();
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    const legacy = {
      request_id: "legacy",
      target_seq: 1,
      cause: "undo" as const,
      state: "queued" as const,
      requested_by: "owner",
    };
    t.pool.undoQueue.push(legacy, { ...legacy, request_id: "duplicate" });
    expect(t.undo({ seq: 1, expect_reverted: [1], request_id: "overlap" })).toEqual({
      ok: false,
      reason: "already_undone",
    });
    t.tick();
    t.pushOk();
    expect(t.pool.landings.filter((l) => l.kind === "undo")).toHaveLength(1);
    expect(t.pool.undoLog.get("duplicate")?.state).toBe("refused");
    expect(t.pool.files.get("world/energy.js")).toBe("export const ENERGY_MAX = 100;\n");
  });

  it("refuses non-changes, already undone, too-old and too-many plans", () => {
    const { trunk: t } = setup();
    expect(t.undoPlan(0)).toEqual({ ok: false, reason: "not_a_change" });
    land(t, "rule", "world/energy.js", "export const ENERGY_MAX = 1;\n");
    t.pool.K.MAX_BATCH = 0;
    expect(t.undoPlan(1)).toEqual({ ok: false, reason: "too_many" });
    t.pool.K.MAX_BATCH = 64;
    t.pool.meta.set("head_seq", String(UNDO_WINDOW + 1));
    expect(t.undoPlan(1)).toEqual({ ok: false, reason: "too_old" });
    t.pool.meta.set("head_seq", "1");
    t.undo({ seq: 1, expect_reverted: [1], request_id: "confirm" });
    t.tick();
    t.pushOk();
    expect(t.undoPlan(1)).toEqual({ ok: false, reason: "already_undone" });
    expect(t.undoPlan(2)).toEqual({ ok: false, reason: "not_a_change" });
  });
});
