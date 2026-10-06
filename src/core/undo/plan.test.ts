import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { Trunk } from "../trunk/registry.ts";
import { planUndo } from "./plan.ts";

const path = "world/values.js";
const seed = "export const ALPHA = 1;\nexport const BETA = 10;\n";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(content = seed) {
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
      [path]: content,
      ".premise/policy.json": JSON.stringify({
        v: 1,
        default: "held",
        tiers: [{ paths: ["world/**"], tier: "auto" }],
      }),
    },
    { now: () => 1000 },
  );
  trunk.pushOk();
  return { trunk, sql };
}

function land(trunk: Trunk, name: string, oldValue: number, newValue: number) {
  landSpan(trunk, name, `${name} = ${oldValue}`, `${name} = ${newValue}`);
}

function landSpan(trunk: Trunk, name: string, old: string, replacement: string, readEntities = [name]) {
  trunk.openAttempt(name, { intent: `change ${name}` });
  for (const entity of readEntities) {
    expect(
      trunk.tool({
        attempt_id: name,
        call_id: `${name}:read:${entity}`,
        tool: "read",
        args: { path, entity },
        ack: 0,
      }).ok,
    ).toBe(true);
  }
  expect(
    trunk.tool({
      attempt_id: name,
      call_id: `${name}:replace`,
      tool: "replace",
      args: { path, old, new: replacement },
      ack: 0,
    }).ok,
  ).toBe(true);
  expect(
    trunk.tool({
      attempt_id: name,
      call_id: `${name}:submit`,
      tool: "submit",
      args: { summary: `change ${name}` },
      ack: 0,
    }).ok,
  ).toBe(true);
  trunk.tick();
  trunk.pushOk();
  expect(trunk.pool.attempts.get(name)?.state).toBe("landed");
}

describe("UN3 composition with earlier undo landings", () => {
  it("adds an independent landing when undo makes its recorded replace ambiguous (UN3/OP2)", () => {
    const original = 'export const ALPHA = "token";\nexport const BETA = "token";\n';
    const { trunk } = setup(original);
    landSpan(trunk, "BETA", 'BETA = "token"', 'BETA = "other"');
    landSpan(trunk, "ALPHA", '"token"', '"value"');

    const plan = planUndo(trunk.pool, 1, trunk.pool.files);
    // ALPHA edited no key written by BETA. Restoring BETA creates the second match of
    // ALPHA's recorded span, so replay alone brings ALPHA into the reverted set.
    expect(plan.depKeys.has(2)).toBe(false);
    expect(plan.reverted).toEqual([1, 2]);
    expect(plan.files.get(path)).toBe(original);
    expect(plan.kept).toEqual([]);
  });

  it("keeps every dependency key when a transitive dependent also depends on the original target (UN2)", () => {
    const original = "export const ALPHA = 1;\nexport const BETA = 10;\nexport const GAMMA = 100;\n";
    const { trunk } = setup(original);
    land(trunk, "ALPHA", 1, 2);
    landSpan(trunk, "BETA", "BETA = 10", "BETA = ALPHA + 10", ["BETA", "ALPHA"]);
    landSpan(trunk, "GAMMA", "GAMMA = 100", "GAMMA = ALPHA + BETA + 100", ["GAMMA", "ALPHA", "BETA"]);

    const plan = planUndo(trunk.pool, 1, trunk.pool.files);
    expect(plan.reverted).toEqual([1, 2, 3]);
    expect(plan.depKeys.get(2)).toEqual(new Set(["entity|world/values.js#ALPHA"]));
    expect(plan.depKeys.get(3)).toEqual(new Set(["entity|world/values.js#ALPHA", "entity|world/values.js#BETA"]));
    expect(plan.files.get(path)).toBe(original);
    expect(plan.kept).toEqual([]);
  });

  it("starts a revert from every landing in its fixed range even when those landings are independent (GR3)", () => {
    const { trunk } = setup();
    land(trunk, "ALPHA", 1, 2);
    land(trunk, "BETA", 10, 20);

    const plan = planUndo(trunk.pool, 1, trunk.pool.files, [1, 2]);
    expect(plan.reverted).toEqual([1, 2]);
    expect(plan.depKeys.size).toBe(0);
    expect(plan.files.get(path)).toBe(seed);
    expect(plan.kept).toEqual([]);
  });

  it("does not resurrect an earlier undone entity when undoing another entity in the same file", () => {
    const { trunk, sql } = setup();
    land(trunk, "ALPHA", 1, 2);
    land(trunk, "BETA", 10, 20);
    expect(trunk.undo({ seq: 1, expect_reverted: [1], request_id: "undo-alpha" }).ok).toBe(true);
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.files.get(path)).toBe("export const ALPHA = 1;\nexport const BETA = 20;\n");

    const reopened = Trunk.open(sql, { now: () => 1000 });
    expect(reopened.undoPlan(2)).toEqual({
      ok: true,
      plan: { target_seq: 2, reverted: [2], reopened: [], kept_readers: [], repairs: [] },
    });
    expect(reopened.undo({ seq: 2, expect_reverted: [2], request_id: "undo-beta" }).ok).toBe(true);
    reopened.tick();
    reopened.pushOk();
    expect(reopened.pool.files.get(path)).toBe(seed);
    expect(reopened.pool.landings.map((landing) => landing.undone_by)).toEqual([3, 4, null, null]);
  });

  it("keeps both confirmed disjoint undos when they land in one tick", () => {
    const { trunk, sql } = setup();
    land(trunk, "ALPHA", 1, 2);
    land(trunk, "BETA", 10, 20);
    expect(trunk.undo({ seq: 1, expect_reverted: [1], request_id: "undo-alpha" }).ok).toBe(true);
    expect(trunk.undo({ seq: 2, expect_reverted: [2], request_id: "undo-beta" }).ok).toBe(true);

    const reopened = Trunk.open(sql, { now: () => 1000 });
    reopened.tick();
    reopened.pushOk();
    expect(reopened.pool.files.get(path)).toBe(seed);
    expect(reopened.pool.landings.map((landing) => landing.undone_by)).toEqual([3, 4, null, null]);
    expect(reopened.pool.landings.slice(2).map((landing) => JSON.parse(landing.note).undo.undoes)).toEqual([[1], [2]]);
  });
});
