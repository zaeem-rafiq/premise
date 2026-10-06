import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REVISIONS } from "../../protocol/constants.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolName } from "../../protocol/tools.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
let nextCall = 1;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  nextCall = 1;
});

const CRAB =
  'import { ENERGY_MAX } from "../world/energy.js";\n' +
  "export function spawn() { return { energy: ENERGY_MAX }; }\n" +
  "export function update(crab) { crab.hiding = crab.energy < 0.3; }\n";

function call(t: Trunk, id: string, tool: ToolName, args: object, ack = 0) {
  const result = t.tool({ attempt_id: id, call_id: `${id}:${nextCall++}`, tool, args, ack });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}

function land(t: Trunk, id: string): void {
  call(t, id, "submit", { summary: `Land ${id}` });
  t.tick();
  t.pushOk();
  expect(t.pool.attempts.get(id)?.state).toBe("landed");
}

function landRule(t: Trunk, id: string, max: number): void {
  t.openAttempt(id, { intent: `Set the energy maximum to ${max}` });
  call(t, id, "read", { path: "world/energy.js" });
  call(t, id, "write", { path: "world/energy.js", content: `export const ENERGY_MAX = ${max};\n` });
  land(t, id);
}

function setup(revision = 1) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec: (query, ...args) => {
      const rows = db.prepare(query).all(...args) as Record<string, unknown>[];
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
  const trunk = Trunk.create(
    sql,
    {
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
      ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
    },
    { now: () => 1000 },
  );
  trunk.pushOk();
  landRule(trunk, "rule", 1);
  trunk.openAttempt("crab", { intent: "Add a crab", model: "recorded-author" });
  call(trunk, "crab", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(trunk, "crab", "write", { path: "creatures/crab.js", content: CRAB });
  land(trunk, "crab");
  // Arrange the history counters at the boundary under test. Reopening the store
  // exercises the persisted landed attempt, not a transient object mutation.
  sql.exec("UPDATE attempts SET revision = ?, go_arounds = 2 WHERE attempt_id = 'crab'", revision).toArray();
  return { trunk: Trunk.open(sql, { now: () => 1000 }), sql };
}

function undo(t: Trunk, seq: number, reverted: number[], request_id: string): void {
  expect(t.undo({ seq, expect_reverted: reverted, request_id })).toEqual({ ok: true, request_id });
  t.tick();
  t.pushOk();
}

function events(t: Trunk, type: string): Array<Record<string, unknown>> {
  return t.pool.sql
    .exec("SELECT body FROM events_out ORDER BY n")
    .toArray()
    .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>)
    .filter((event) => event.type === type);
}

function restored(t: Trunk, seq: number, wake: boolean): void {
  const crab = t.pool.attempts.get("crab")!;
  expect(t.pool.files.has("creatures/crab.js")).toBe(false);
  expect(crab.ops).toEqual([
    { op: "write", op_seq: 1, path: "creatures/crab.js", content: CRAB, base_oid: "absent", dropped: false },
  ]);
  expect(crab.opCount).toBe(1);
  expect(crab.premises.size).toBeGreaterThan(0);
  for (const premise of crab.premises.values()) {
    expect(premise.seq).toBe(seq);
    expect(premise.shown).toBeNull();
  }
  expect(crab.premises.get("entity|world/energy.js#ENERGY_MAX")).toMatchObject({
    derived: true,
    status: "pending_repair",
  });
  expect(crab.heads).toHaveLength(1);
  expect(crab.heads[0]?.body).toMatchObject({
    result: "repair",
    wake,
    cause: { type: "undo", seqs: [seq] },
    dropped_ops: [],
  });
  expect(crab.heads[0]?.body.items.map((item) => ({ key: item.premise.key, rule: item.rule }))).toEqual([
    { key: "world/energy.js#ENERGY_MAX", rule: "E2" },
  ]);
}

describe("undo reopening and revert-limit choices (UN6, UN8, T18, T19, T19s, GL6)", () => {
  it("T18/T19: undo stops its target and reopens the dependent with its author and next revision", () => {
    const { trunk, sql } = setup();
    undo(trunk, 1, [1, 2], "normal");
    const t = Trunk.open(sql, { now: () => 1000 });
    expect(t.pool.attempts.get("rule")).toMatchObject({ state: "stopped", stop_reason: "undone" });
    expect(t.pool.intents.get("i_rule")?.state).toBe("undone");
    expect(t.pool.attempts.get("crab")).toMatchObject({
      state: "going_around",
      revision: 2,
      go_arounds: 3,
      resumes: 1,
      model: "recorded-author",
      right_of_way_at: null,
    });
    expect(events(t, "attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: "crab", cause: "undo", revision: 2, model_changed: false }),
    ]);
    restored(t, 3, true);
  });

  it("RS1: a queued revert range reopens both changes with cause revert", () => {
    const { trunk: t, sql } = setup();
    t.pool.undoQueue.push({
      request_id: "green-revert",
      target_seq: 1,
      cause: "revert",
      state: "queued",
      requested_by: "green-line",
      reverted: [1, 2],
    });
    t.tick();
    t.pushOk();
    const restored = Trunk.open(sql, { now: () => 1000 });
    expect(restored.pool.landings.at(-1)).toMatchObject({ kind: "revert" });
    expect(restored.pool.files.get("world/energy.js")).toBe("export const ENERGY_MAX = 100;\n");
    expect(restored.pool.files.has("creatures/crab.js")).toBe(false);
    for (const id of ["rule", "crab"]) {
      expect(restored.pool.attempts.get(id)).toMatchObject({ state: "going_around", revision: 2, resumes: 1 });
      expect(restored.pool.meta.get(`resume_cause:${id}`)).toBe("revert");
      expect(restored.pool.attempts.get(id)?.heads.at(-1)?.body.cause.type).toBe("revert");
    }
    expect(events(restored, "attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: "rule", cause: "revert", revision: 2 }),
      expect.objectContaining({ attempt_id: "crab", cause: "revert", revision: 2 }),
    ]);
  });

  it("T19s/UN8: a dependent at MAX_REVISIONS stays reverted and parked with exactly retry and stop", () => {
    const { trunk, sql } = setup(MAX_REVISIONS);
    undo(trunk, 1, [1, 2], "limit");
    const t = Trunk.open(sql, { now: () => 1000 });
    expect(t.pool.landings.find((landing) => landing.seq === 2)?.undone_by).toBe(3);
    expect(t.pool.attempts.get("crab")).toMatchObject({
      state: "stopped",
      stop_reason: "revert_limit",
      revision: MAX_REVISIONS,
      go_arounds: 2,
      resumes: 0,
      model: "recorded-author",
    });
    expect(events(t, "attempt.reopened")).toEqual([]);
    expect(events(t, "attempt.state")).toContainEqual(
      expect.objectContaining({
        attempt_id: "crab",
        from: "landed",
        to: "stopped",
        transition: "T19s",
        reason: "revert_limit",
      }),
    );
    const cards = t.pool.cards.filter((card) => card.open);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "choice", reason: "revert_limit", attempt_ids: ["crab"] });
    expect(cards[0]?.body.options.map((option) => option.id)).toEqual(["retry", "stop"]);
    restored(t, 3, false);
  });

  it("GL6: retry adds one revision and the next undo requires another owner choice", () => {
    const { trunk: t } = setup(MAX_REVISIONS);
    undo(t, 1, [1, 2], "first-limit");
    // While parked, the attempt receives the next changed fact without waking.
    landRule(t, "next-rule", 50);
    const parked = t.pool.attempts.get("crab")!;
    expect(parked.state).toBe("stopped");
    expect(parked.heads).toHaveLength(2);
    expect(parked.heads[1]?.body.wake).toBe(false);
    t.owner({ action: "retry", attempt: "crab" });
    expect(t.pool.attempts.get("crab")).toMatchObject({
      state: "going_around",
      stop_reason: null,
      revision: MAX_REVISIONS + 1,
      resumes: 1,
      model: "recorded-author",
    });
    expect(events(t, "attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: "crab", cause: "retry", revision: MAX_REVISIONS + 1 }),
    ]);
    call(t, "crab", "read", { path: "world/energy.js", entity: "ENERGY_MAX" }, 2);
    call(t, "crab", "replace", { path: "creatures/crab.js", old: "crab.energy < 0.3", new: "crab.energy < 15" }, 2);
    const submit = call(
      t,
      "crab",
      "submit",
      {
        summary: "Add a crab using energy out of 50",
        acknowledge: [1, 2],
        statement: "The threshold is now 15 points.",
      },
      2,
    );
    expect(submit.result).toMatchObject({ status: "validated" });
    t.tick();
    t.pushOk();
    expect(t.pool.attempts.get("crab")?.state).toBe("landed");
    undo(t, 4, [4, 5], "second-limit");
    expect(t.pool.landings.find((landing) => landing.seq === 5)?.undone_by).toBe(6);
    expect(t.pool.attempts.get("crab")).toMatchObject({
      state: "stopped",
      stop_reason: "revert_limit",
      revision: MAX_REVISIONS + 1,
      resumes: 1,
    });
    expect(t.pool.files.has("creatures/crab.js")).toBe(false);
    const cards = t.pool.cards.filter((card) => card.open);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body.options.map((option) => option.id)).toEqual(["retry", "stop"]);
    expect(events(t, "attempt.reopened")).toHaveLength(1);
  });

  it("GL6: stop keeps the landing reverted and removes the parked premises and operations", () => {
    const { trunk: t, sql } = setup(MAX_REVISIONS);
    undo(t, 1, [1, 2], "stop-limit");
    t.owner({ action: "stop", attempt: "crab" });
    const reopened = Trunk.open(sql, { now: () => 1000 });
    const crab = reopened.pool.attempts.get("crab")!;
    expect(crab).toMatchObject({ state: "stopped", stop_reason: "revert_limit", revision: MAX_REVISIONS, resumes: 0 });
    expect(crab.premises.size).toBe(0);
    expect(crab.ops).toEqual([]);
    expect(reopened.pool.cards.filter((card) => card.open)).toEqual([]);
    expect(reopened.pool.landings.find((landing) => landing.seq === 2)?.undone_by).toBe(3);
    expect(reopened.pool.files.has("creatures/crab.js")).toBe(false);
    expect(events(reopened, "attempt.reopened")).toEqual([]);
  });
});
