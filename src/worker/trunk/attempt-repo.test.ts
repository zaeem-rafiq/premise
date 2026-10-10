import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Trunk } from "../../core/trunk/registry.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolName } from "../../protocol/tools.ts";
import { attemptCheckpointView, recordAttemptRepository } from "./attempt-repo.ts";
import { attemptRepoName } from "../adapters/attempt-repo/index.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(files: Record<string, string>) {
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
  const trunk = Trunk.create(
    sql,
    { ".premise/policy.json": '{"v":1,"default":"auto"}', ...files },
    { now: () => 1_000 },
  );
  trunk.pushOk();
  let nextCall = 0;
  const call = (attemptId: string, tool: ToolName, args: object, ack = 0) => {
    const result = trunk.tool({ attempt_id: attemptId, call_id: `call-${++nextCall}`, tool, args, ack });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const land = (attemptId: string) => {
    call(attemptId, "submit", { summary: `Land ${attemptId}` });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.state(attemptId)).toBe("landed");
  };
  return { trunk, sql, call, land };
}

it("AG5 UN8 RS1: a reopened attempt checkpoints its new view, including after it stops", () => {
  const { trunk, sql, call, land } = fixture({ "world/energy.js": "export const ENERGY_MAX = 100;\n" });
  trunk.openAttempt("rule", { intent: "Use energy out of one", agent_kind: "real" });
  call("rule", "read", { path: "world/energy.js" });
  call("rule", "write", { path: "world/energy.js", content: "export const ENERGY_MAX = 1;\n" });
  land("rule");
  trunk.openAttempt("crab", { intent: "Add a crab", agent_kind: "real" });
  call("crab", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call("crab", "write", {
    path: "creatures/crab.js",
    content:
      'import { ENERGY_MAX } from "../world/energy.js";\n' +
      "export function spawn() { return { energy: ENERGY_MAX }; }\n" +
      "export function update(crab) { crab.hiding = crab.energy < 0.3; }\n",
  });
  land("crab");
  expect(trunk.undo({ seq: 1, expect_reverted: [1, 2], request_id: "undo-rule" })).toEqual({
    ok: true,
    request_id: "undo-rule",
  });
  trunk.tick();
  trunk.pushOk();
  expect(trunk.pool.attempts.get("crab")).toMatchObject({ state: "going_around", landed_seq: 2, revision: 2 });
  call("crab", "read", { path: "world/energy.js", entity: "ENERGY_MAX" }, 1);
  call("crab", "replace", { path: "creatures/crab.js", old: "crab.energy < 0.3", new: "crab.energy < 30" }, 1);
  const files = {
    "creatures/crab.js":
      'import { ENERGY_MAX } from "../world/energy.js";\n' +
      "export function spawn() { return { energy: ENERGY_MAX }; }\n" +
      "export function update(crab) { crab.hiding = crab.energy < 30; }\n",
  };
  expect(attemptCheckpointView(trunk.pool, "crab")).toMatchObject({ files });
  trunk.stop({ attempt_id: "crab", reason: "cancelled" });
  expect(trunk.state("crab")).toBe("stopped");
  expect(attemptCheckpointView(Trunk.open(sql).pool, "crab")).toMatchObject({ files });
});

it("AG5 S3: accepted and landed checkpoints keep the attempt's exact landing tree", () => {
  const { trunk, call, land } = fixture({ "guide.txt": "Guide\n" });
  trunk.openAttempt("first", { intent: "Add an exclamation", agent_kind: "real" });
  call("first", "read", { path: "guide.txt" });
  call("first", "replace", { path: "guide.txt", old: "Guide", new: "Guide!" });
  call("first", "submit", { summary: "Add an exclamation" });
  trunk.tick();
  expect(trunk.state("first")).toBe("accepted");
  expect(attemptCheckpointView(trunk.pool, "first")).toMatchObject({ files: { "guide.txt": "Guide!\n" } });
  trunk.pushOk();
  trunk.openAttempt("second", { intent: "Change the guide", agent_kind: "real" });
  call("second", "read", { path: "guide.txt" });
  call("second", "write", { path: "guide.txt", content: "Later guide\n" });
  land("second");
  expect(trunk.pool.files.get("guide.txt")).toBe("Later guide\n");
  expect(attemptCheckpointView(trunk.pool, "first")).toMatchObject({ files: { "guide.txt": "Guide!\n" } });
});

it("S3 SE22: synthetic and unknown attempts cannot produce archive snapshots or repository receipts", () => {
  const { trunk, sql } = fixture({ "guide.txt": "Guide\n" });
  trunk.openAttempt("scripted", { intent: "Run a scripted attempt", agent_kind: "synthetic" });
  expect(attemptCheckpointView(trunk.pool, "scripted")).toBeNull();
  expect(attemptCheckpointView(trunk.pool, "missing")).toBeNull();
  expect(recordAttemptRepository(sql, { attempt_id: "scripted", repo: attemptRepoName("scripted") }).status).toBe(404);
  expect(recordAttemptRepository(sql, { attempt_id: "missing", repo: attemptRepoName("missing") }).status).toBe(404);
  expect(trunk.pool.attempts.get("scripted")?.attempt_repo).toBeNull();
});
