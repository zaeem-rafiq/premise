// CK6b (01-core 9.5): a submit whose module names a colour outside the pen's palette is rejected
// with `unknown_colour`, and its detail lists the palette, so the agent repairs it before landing
// instead of the isolate green line taking the landing back (found on production 2026-10-11).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Trunk } from "../../src/core/trunk/registry.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";
import { sqlOver } from "./driver.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(withPen: boolean) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const trunk = Trunk.create(
    sqlOver(db),
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "world/energy.js":
        "export const ENERGY_MAX = 100;\nexport function drain(creature, amount) {\n  creature.energy = Math.max(0, creature.energy - amount);\n}\n",
      ...(withPen ? { "pen.js": readFileSync("seeds/tidepool/pen.js", "utf8") } : {}),
    },
    { now: () => 1_000, syncTriage: ScriptedTriage, constants: { MAX_BATCH: 1 } },
  );
  trunk.pushOk();
  let n = 0;
  const call = (tool: ToolRequest["tool"], args: ToolRequest["args"]) =>
    trunk.tool({ attempt_id: "a", call_id: `c-${++n}`, tool, args, ack: trunk.pool.attempts.get("a")!.heads.length });
  trunk.openAttempt("a", { intent: "a jellyfish" });
  return { call };
}

const JELLY = (colour: string) =>
  `export const kind = "jellyfish";\nconst TENTACLE = "${colour}";\nexport const tint = TENTACLE;\n`;

describe("CK6b colours_known", () => {
  it("rejects lightblue with the path, the name and the palette; passes once it is a palette name", () => {
    const { call } = fixture(true);
    call("write", { path: "creatures/jellyfish.js", content: JELLY("lightblue") });
    const rejected = call("submit", { summary: "a jellyfish" }).result as {
      status: string;
      errors: Array<{ code: string; detail: { path: string; names: string[]; palette: string[] } }>;
    };
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors[0]!.code).toBe("unknown_colour");
    expect(rejected.errors[0]!.detail.path).toBe("creatures/jellyfish.js");
    expect(rejected.errors[0]!.detail.names).toEqual(["lightblue"]);
    expect(rejected.errors[0]!.detail.palette).toContain("blue");

    call("write", { path: "creatures/jellyfish.js", content: JELLY("blue") });
    const ok = call("submit", { summary: "a jellyfish" }).result as {
      status: string;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(ok.status).toBe("validated");
    expect(ok.checks).toContainEqual({ name: "colours_known", ok: true });
  });

  it("does not run in a pool without a pen palette", () => {
    const { call } = fixture(false);
    call("write", { path: "creatures/jellyfish.js", content: JELLY("lightblue") });
    const r = call("submit", { summary: "a jellyfish" }).result as { status: string; checks: Array<{ name: string }> };
    expect(r.status).toBe("validated");
    expect(r.checks.map((c) => c.name)).not.toContain("colours_known");
  });

  it("CK6d: a creature that spends energy by hand is rejected with energy_direct; with drain() it passes", () => {
    const { call } = fixture(true);
    const squid = (spend: string) =>
      `import { ENERGY_MAX, drain } from "../world/energy.js";\nexport function update(squid) {\n  ${spend}\n}\n`;
    call("write", { path: "creatures/squid.js", content: squid("squid.energy -= ENERGY_MAX / 10;") });
    const rejected = call("submit", { summary: "a squid" }).result as {
      status: string;
      errors: Array<{ code: string; detail: { path: string; lines: number[] } }>;
    };
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors[0]!.code).toBe("energy_direct");
    expect(rejected.errors[0]!.detail).toMatchObject({ path: "creatures/squid.js", lines: [3] });

    call("write", { path: "creatures/squid.js", content: squid("drain(squid, ENERGY_MAX / 10);") });
    const ok = call("submit", { summary: "a squid" }).result as {
      status: string;
      checks: Array<{ name: string; ok: boolean }>;
    };
    // It never read drain, so CK7 asks it to confirm that blind spot; CK6d itself has passed.
    expect(["validated", "needs_confirm"]).toContain(ok.status);
  });
});
