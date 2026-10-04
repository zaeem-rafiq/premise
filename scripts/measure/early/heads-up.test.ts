// The scripted landing heads-up of ME5: one landing on world/energy.js, pushed after the first
// submit in hero mode, shaped as the HeadsUp of 05-agent 3.8 — result repair, cause landing, one
// E2 item on entity:world/energy.js#ENERGY_MAX with the entity hashes of 01-core 2.4, the entity
// diff, and `uses` = every ENERGY_MAX line of the run's creature file.

import { describe, it, expect } from "vitest";
import {
  buildHeroHeadsUp,
  landEnergyChange,
  energyUses,
  referencesEnergyMax,
  ENERGY_PATH,
  ENERGY_BEFORE,
  ENERGY_AFTER,
} from "./heads-up.ts";
import { loadSeed } from "../models.ts";

const CRAB = `import { ENERGY_MAX } from "../world/energy.js";\nexport function spawn() { return { energy: ENERGY_MAX }; }\nexport function update(c) { c.hiding = c.energy < 30; }\nexport function draw(c, pen) { pen.fill("red"); }\n`;

const make = (content = CRAB) => {
  const hu = buildHeroHeadsUp({
    attemptId: "a_x",
    creaturePath: "creatures/crab.js",
    creatureSource: content,
    now: 1000,
  });
  if (hu === null) throw new Error("expected a heads-up");
  return hu;
};

describe("ME5: the scripted energy landing", () => {
  it("landEnergyChange applies the exact canned diff of 05-agent 6.2", () => {
    const seed = loadSeed();
    const before = seed.get(ENERGY_PATH) as string;
    expect(before.startsWith(ENERGY_BEFORE)).toBe(true);
    const after = landEnergyChange(before);
    expect(after.startsWith(ENERGY_AFTER)).toBe(true);
    expect(after).not.toContain("= 100");
    expect(after.slice(ENERGY_AFTER.length)).toBe(before.slice(ENERGY_BEFORE.length));
  });

  it("referencesEnergyMax is false when ENERGY_MAX appears only in the import", () => {
    expect(referencesEnergyMax('import { ENERGY_MAX } from "../world/energy.js";\nexport const A = 1;\n')).toBe(false);
    expect(referencesEnergyMax(CRAB)).toBe(true);
  });

  it("the heads-up is hn 1, result repair, wake, cause landing (HU1, HE2)", () => {
    const hu = make();
    expect(hu.hn).toBe(1);
    expect(hu.result).toBe("repair");
    expect(hu.wake).toBe(true);
    expect(hu.cause).toEqual({
      type: "landing",
      seqs: [1],
      changes: [{ seq: 1, change_id: "c_a_x_rescale", intent_text: "make energy a fraction from 0 to 1" }],
    });
    expect(hu.go_around).toBe(1);
    expect(hu.head_seq).toBe(1);
    expect(hu.dropped_ops).toEqual([]);
  });

  it("the item is rule E2 repair referenced_entity_changed with the spec's entity hashes", () => {
    const item = make().items[0];
    expect(item).toMatchObject({
      premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
      rule: "E2",
      result: "repair",
      reason: "referenced_entity_changed",
      old_hash: "5149f012fe7cd2dfd8820a214ea41ff0",
      new_hash: "f52fdb40e9972b45534f0361ecb65cea",
      cause_seq: 1,
    });
  });

  it("the diff is the entity before/after of 05-agent 3.8, verbatim", () => {
    const item = make().items[0];
    expect(item?.diff).toEqual({ kind: "entity", before: ENERGY_BEFORE, after: ENERGY_AFTER });
  });

  it("uses lists every ENERGY_MAX line of the creature with its containing entity", () => {
    const uses = make().items[0]?.uses ?? [];
    expect(uses.map((u) => [u.path, u.entity, u.line])).toEqual([
      ["creatures/crab.js", "(import ../world/energy.js)", 1],
      ["creatures/crab.js", "spawn", 2],
    ]);
    expect(uses[0]?.text).toBe('import { ENERGY_MAX } from "../world/energy.js";');
  });

  it("a creature with no ENERGY_MAX use gets no heads-up (HC3(a): none is sent)", () => {
    const hu = buildHeroHeadsUp({
      attemptId: "a_x",
      creaturePath: "creatures/crab.js",
      creatureSource: "export const A = 1;\n",
      now: 0,
    });
    expect(hu).toBeNull();
  });

  it("energyUses is a pure line scan: no import needed", () => {
    const uses = energyUses("p.js", "const x = ENERGY_MAX;\n");
    expect(uses).toEqual([{ path: "p.js", entity: "x", line: 1, text: "const x = ENERGY_MAX;" }]);
  });
});
