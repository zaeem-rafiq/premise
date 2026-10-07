// The mutable tool results of 4.3 and 4.4 must not expose a cached module's export arrays.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { OutlineResult, ReadEntityResult } from "../../protocol/tools.ts";
import { parseModule } from "../entities/entities.ts";
import { analyse, refsMembers } from "../refs/refs.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const source = "const value = 1;\nexport { value, value as alias };\n";
const expectedExports = ["alias", "value"];

function fixture(extra: string) {
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
    { "module.js": source, "extra.txt": extra, ".premise/policy.json": '{"v":1,"default":"auto"}' },
    { now: () => 1_000 },
  );
  trunk.pushOk();
  trunk.openAttempt("first", { intent: "Inspect exports" });
  trunk.openAttempt("second", { intent: "Inspect the same module" });
  let call = 0;
  return (tool: "outline" | "read", attempt = "first"): string[] => {
    call += 1;
    const response = trunk.tool({
      attempt_id: attempt,
      call_id: `${attempt}-${call}`,
      tool,
      args: tool === "outline" ? { path: "module.js" } : { path: "module.js", entity: "value" },
      ack: 0,
    });
    expect(response.ok).toBe(true);
    return tool === "outline"
      ? (response.result as OutlineResult).entities.find((entity) => entity.name === "value")!.exports
      : (response.result as ReadEntityResult).exports;
  };
}

describe("read tool results preserve shared module exports", () => {
  it.each(["outline", "read"] as const)("mutating %s exports cannot alter another parse, tree, or attempt", (tool) => {
    const original = parseModule(source);
    const cachedExports = original.entities.find((entity) => entity.name === "value")!.exports;
    const firstPool = fixture("first tree");
    const secondPool = fixture("second tree");
    const returnedExports = firstPool(tool);
    expect(returnedExports).toEqual(expectedExports);
    expect(returnedExports).not.toBe(cachedExports);
    returnedExports.splice(0, returnedExports.length, "corrupted");

    expect(parseModule(source)).toBe(original);
    expect(cachedExports).toEqual(expectedExports);
    for (const nextTool of ["outline", "read"] as const) {
      expect(firstPool(nextTool)).toEqual(expectedExports);
      expect(firstPool(nextTool, "second")).toEqual(expectedExports);
      expect(secondPool(nextTool)).toEqual(expectedExports);
    }

    // 6.2: a fresh tree must still resolve the exported name after a caller changes its result.
    const analysis = analyse(
      new Map([
        ["module.js", source],
        ["consumer.js", 'import { value } from "./module.js";\n'],
      ]),
    );
    expect(analysis.modules.get("module.js")).toBe(original);
    expect(analysis.unresolved).toEqual([]);
    expect(refsMembers("module.js#value", analysis).filter((member) => member.includes("#"))).toEqual([
      "consumer.js#(import ./module.js)",
    ]);
  });
});
