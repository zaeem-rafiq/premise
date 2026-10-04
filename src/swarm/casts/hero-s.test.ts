// `hero-s` (02-tidepool.md 7.3, 10.5): the rescale verbatim, the D2 visits to every landed
// creature module `relied_on_by` names (order 2b), and the QR1 `repair` that fixes the new
// referrers without a read (7.6 step 5).

import { describe, expect, it } from "vitest";
import { HERO_S } from "./hero-s.ts";
import { bag, entityDiff, hu, item, ok, queryDiff, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });
const Q = (key: string) => ({ kind: "query" as const, key });
const ENERGY_OLD = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;
const ENERGY_NEW = `// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;`;
const REFS = { "world/energy.js#ENERGY_MAX": ["creatures/crab.js#update"] };
const CRAB_UPDATE = `export function update(crab) {
  if (crab.energy < 30) crab.hiding = true;
}`;

describe("hero-s (02-tidepool.md 10.5)", () => {
  it("carries the intent, summary and truth list of the table", () => {
    expect(HERO_S.id).toBe("hero-s");
    expect(HERO_S.intent).toBe("make energy a fraction from 0 to 1");
    expect(HERO_S.truth).toEqual(["entity:world/energy.js#ENERGY_MAX", "query:refs:world/energy.js#ENERGY_MAX"]);
  });

  it("reads the guide and the energy file, replaces ENERGY_MAX and submits with its summary", () => {
    const b = bag();
    expect(step(HERO_S, b, null)).toMatchObject({ kind: "tool", tool: "read", args: { path: "GUIDE.md" } });
    expect(step(HERO_S, b, ok())).toMatchObject({ tool: "read", args: { path: "world/energy.js" } });
    expect(step(HERO_S, b, ok())).toMatchObject({
      tool: "replace",
      args: { path: "world/energy.js", old: ENERGY_OLD, new: ENERGY_NEW },
    });
    expect(step(HERO_S, b, ok())).toMatchObject({
      tool: "submit",
      args: { summary: "Make energy a fraction from 0 to 1" },
    });
  });

  it("visits each creature module `relied_on_by` names and fixes the canned old text (2b)", () => {
    const b = bag();
    step(HERO_S, b, null); step(HERO_S, b, ok());
    step(HERO_S, b, ok()); // the `replace` is issued; `relied_on_by` rides its answer (D2)
    expect(step(HERO_S, b, ok({ relied_on_by: REFS }))).toMatchObject({
      tool: "read", args: { path: "creatures/crab.js", entity: "update" },
    });
    expect(step(HERO_S, b, ok({ source: CRAB_UPDATE }))).toMatchObject({
      tool: "replace",
      args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" },
    });
    expect(step(HERO_S, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("a QR1 `repair` fixes the gained referrers from the item's sources, no read (7.6)", () => {
    const b = bag();
    step(HERO_S, b, null); step(HERO_S, b, ok()); step(HERO_S, b, ok());
    const next = step(HERO_S, b, ok(), [
      hu(1, "repair", [
        item(Q("refs:world/energy.js#ENERGY_MAX"), queryDiff([
          { key: "creatures/crab.js#update", source: CRAB_UPDATE },
          { key: "creatures/shrimp.js#update", source: "drain(shrimp, 5);" },
        ]), "repair", "QR1"),
      ]),
    ]);
    expect(next).toMatchObject({
      tool: "replace",
      args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" },
    });
    expect(step(HERO_S, b, ok())).toMatchObject({
      tool: "replace",
      args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" },
    });
    const s = step(HERO_S, b, ok());
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change.",
    });
  });
});
