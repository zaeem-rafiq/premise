// The scoring functions of 05-agent 6.5 and ME8, tested against hand-written final files whose
// expected classes come from the specification — never from a run.

import { describe, it, expect } from "vitest";
import { checkTree, scoreCompleted, referencesEnergyMax, energyNumbers, classifyHero } from "./score.ts";
import { loadSeed } from "../models.ts";

const tree = (extra: Record<string, string> = {}) => new Map<string, string>([...loadSeed(), ...Object.entries(extra)]);
const seedPaths = new Set(loadSeed().keys());

const CRAB_BEFORE = `import { ENERGY_MAX } from "../world/energy.js";\nexport function spawn() { return { energy: ENERGY_MAX }; }\nexport function update(crab) { crab.hiding = crab.energy < 30; }\nexport function draw(crab, pen) { pen.fill("red"); }\n`;
const CRAB_AFTER = CRAB_BEFORE.replace("crab.energy < 30", "crab.energy < 0.3");

describe("checkTree (6.5: every .js parses, every relative import resolves)", () => {
  it("the seed tree is clean", () => {
    expect(checkTree(loadSeed()).ok).toBe(true);
  });
  it("a syntax error names the file in parse_errors", () => {
    const t = tree({ "creatures/bad.js": "export const = ;\n" });
    const c = checkTree(t);
    expect(c.ok).toBe(false);
    expect(c.parse_errors[0]).toContain("creatures/bad.js");
  });
  it("an import of a missing file or missing export lands in import_errors", () => {
    const t = tree({ "creatures/x.js": 'import { NOPE } from "../world/energy.js";\nexport const A = 1;\n' });
    expect(checkTree(t).import_errors[0]).toContain("no export NOPE");
    const t2 = tree({ "creatures/x.js": 'import { x } from "../world/nope.js";\nexport const A = 1;\n' });
    expect(checkTree(t2).import_errors[0]).toContain("names no file");
  });
});

describe("scoreCompleted (6.5 'completed (early)')", () => {
  const base = { files: tree({ "creatures/crab.js": CRAB_BEFORE }), seedPaths, writes: "creatures/crab.js" };
  it("completed: the Writes file exists and exports spawn/update/draw as functions", () => {
    expect(scoreCompleted({ ...base, passedSubmit: true })).toBe("completed");
  });
  it("not_completed without a passing submit, whatever the tree holds", () => {
    expect(scoreCompleted({ ...base, passedSubmit: false })).toBe("not_completed");
  });
  it("other_name: only one added creatures/*.js carries the three exports, under another name", () => {
    const files = tree({ "creatures/krabb.js": CRAB_BEFORE });
    expect(scoreCompleted({ files, seedPaths, writes: "creatures/crab.js", passedSubmit: true })).toBe("other_name");
  });
  it("not_completed when the Writes file exists but draw is not a function", () => {
    const files = tree({ "creatures/crab.js": CRAB_BEFORE.replace("export function draw", "export const draw =") });
    expect(scoreCompleted({ files, seedPaths, writes: "creatures/crab.js", passedSubmit: true })).toBe("not_completed");
  });
});

describe("referencesEnergyMax (6.5)", () => {
  it("true when the file imports ENERGY_MAX and uses it outside the import", () => {
    expect(referencesEnergyMax("creatures/crab.js", CRAB_BEFORE)).toBe(true);
  });
  it("false when it only sits in the import line, or the import names another module", () => {
    expect(
      referencesEnergyMax("creatures/c.js", 'import { ENERGY_MAX } from "../world/energy.js";\nexport const A = 1;\n'),
    ).toBe(false);
    expect(
      referencesEnergyMax(
        "creatures/c.js",
        'import { ENERGY_MAX } from "../world/time.js";\nexport const A = ENERGY_MAX;\n',
      ),
    ).toBe(false);
  });
});

describe("the energy numbers of a file (6.5)", () => {
  it("(a) arguments of drain/feed calls", () => {
    expect(energyNumbers("export function update(s) { drain(s, 5); feed(s, 2); }\n").sort()).toEqual([2, 5]);
  });
  it("(b) either side of a comparison with .energy", () => {
    const num = (a: number, b: number) => a - b;
    expect(
      energyNumbers("export function update(c) { c.h = c.energy < 30; c.x = 0.5 > c.energy; }\n").sort(num),
    ).toEqual([0.5, 30]);
    expect(energyNumbers("export function update(c) { c.h = c.energy < 30 + 5; }\n").sort(num)).toEqual([5, 30]);
  });
  it("(c) initializers of top-level consts, except `count`", () => {
    const src =
      "export const THRESHOLD = 30;\nexport const count = 4;\nexport const NEG = -3;\nexport function update(c) { c.h = c.energy < THRESHOLD; }\n";
    expect(energyNumbers(src).sort((a, b) => a - b)).toEqual([-3, 30]);
  });
  it("numbers inside draw do not count; numbers inside functions that are not draw do", () => {
    const src =
      "export function draw(c, pen) { pen.circle(0, 0, 99); }\nexport function update(c) { c.h = c.energy < 30; }\n";
    expect(energyNumbers(src)).toEqual([30]);
  });
  it("a leading minus belongs to the literal; arithmetic counts inside", () => {
    expect(energyNumbers("export function update(c) { c.h = c.energy < -0.3; }\n")).toEqual([-0.3]);
  });
});

describe("classifyHero (ME8, first row that applies)", () => {
  const base = { intent: "P1a" as const, creaturePath: "creatures/crab.js" };
  it("not_completed: the first submit never passed", () => {
    expect(
      classifyHero({
        ...base,
        firstSubmitPassed: false,
        before: CRAB_BEFORE,
        finalSource: CRAB_AFTER,
        secondSubmitPassed: true,
      }),
    ).toBe("not_completed");
  });
  it("no_reference: the kept file never referenced ENERGY_MAX", () => {
    const noRef =
      "export function spawn() { return {}; }\nexport function update(c) { c.h = c.energy < 30; }\nexport function draw(c, p) { p.fill(0); }\n";
    expect(
      classifyHero({ ...base, firstSubmitPassed: true, before: noRef, finalSource: noRef, secondSubmitPassed: true }),
    ).toBe("no_reference");
  });
  it("relative: it referenced ENERGY_MAX but carried no absolute energy number", () => {
    const rel = CRAB_BEFORE.replace("crab.energy < 30", "crab.energy < ENERGY_MAX / 2");
    expect(
      classifyHero({ ...base, firstSubmitPassed: true, before: rel, finalSource: rel, secondSubmitPassed: true }),
    ).toBe("relative");
  });
  it("not_answered: the second submit never passed", () => {
    expect(
      classifyHero({
        ...base,
        firstSubmitPassed: true,
        before: CRAB_BEFORE,
        finalSource: null,
        secondSubmitPassed: false,
      }),
    ).toBe("not_answered");
  });
  it("repaired: the new number appears and the old is gone (30 -> 0.3, P1a)", () => {
    expect(
      classifyHero({
        ...base,
        firstSubmitPassed: true,
        before: CRAB_BEFORE,
        finalSource: CRAB_AFTER,
        secondSubmitPassed: true,
      }),
    ).toBe("repaired");
  });
  it("repaired for P1b's 5 -> 0.05 in a drain call", () => {
    const before =
      'import { ENERGY_MAX, drain } from "../world/energy.js";\nexport function spawn() { return { energy: ENERGY_MAX }; }\nexport function update(s) { drain(s, 5); }\nexport function draw(s, p) { p.fill(0); }\n';
    const after = before.replace("drain(s, 5)", "drain(s, 0.05)");
    expect(
      classifyHero({
        intent: "P1b",
        creaturePath: "creatures/shrimp.js",
        firstSubmitPassed: true,
        before,
        finalSource: after,
        secondSubmitPassed: true,
      }),
    ).toBe("repaired");
  });
  it("not_repaired: the energy numbers are unchanged", () => {
    const same = CRAB_BEFORE.replace('pen.fill("red")', 'pen.fill("blue")');
    expect(
      classifyHero({
        ...base,
        firstSubmitPassed: true,
        before: CRAB_BEFORE,
        finalSource: same,
        secondSubmitPassed: true,
      }),
    ).toBe("not_repaired");
  });
  it("unclear: numbers changed but not to the expected value", () => {
    const odd = CRAB_BEFORE.replace("crab.energy < 30", "crab.energy < 12");
    expect(
      classifyHero({
        ...base,
        firstSubmitPassed: true,
        before: CRAB_BEFORE,
        finalSource: odd,
        secondSubmitPassed: true,
      }),
    ).toBe("unclear");
  });
});
