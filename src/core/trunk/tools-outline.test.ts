// The `outline` tool of 4.3 gives each entity's signature in the form of the specification's example,
// never the entity's canonical form (2.4), which holds the whole syntax tree of its statements.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { OutlineResult } from "../../protocol/tools.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

// The two entities of the example of 4.3, with the bodies the seed's rules would give them.
const energy =
  "export const ENERGY_MAX = 100;\n" +
  "\n" +
  "export function drain(creature, amount) {\n" +
  "  creature.energy = Math.max(0, creature.energy - amount);\n" +
  "  return creature;\n" +
  "}\n";

function outline(path: string, files: Record<string, string>): OutlineResult {
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
    { ...files, ".premise/policy.json": '{"v":1,"default":"auto"}' },
    { now: () => 1_000 },
  );
  trunk.pushOk();
  trunk.openAttempt("A", { intent: "Look at the energy rule" });
  const response = trunk.tool({ attempt_id: "A", call_id: "A:1", tool: "outline", args: { path }, ack: 0 });
  expect(response.ok).toBe(true);
  return response.result as OutlineResult;
}

describe("4.3 outline", () => {
  it("gives the signatures of the example of 4.3, not the canonical form", () => {
    const result = outline("world/energy.js", { "world/energy.js": energy });
    expect(result.entities.map(({ name, kind, exports, signature }) => ({ name, kind, exports, signature }))).toEqual([
      { name: "ENERGY_MAX", kind: "const", exports: ["ENERGY_MAX"], signature: "export const ENERGY_MAX" },
      { name: "drain", kind: "function", exports: ["drain"], signature: "export function drain(creature, amount)" },
    ]);
  });

  it("writes an unexported declaration without the export keyword", () => {
    const result = outline("world/rest.js", {
      "world/rest.js": "const REST_TICKS = 300;\nfunction wake(c) {\n  return c;\n}\n",
    });
    expect(result.entities.map((entity) => entity.signature)).toEqual(["const REST_TICKS", "function wake(c)"]);
  });
});
