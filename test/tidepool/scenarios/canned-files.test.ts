// Appendix A rows A7 and A8 for the canned material: every canned file of 7.3, 8.2, 9.5 and 10.5,
// and `world/energy.js` as it stands after P9a, parses, resolves its imports and uses only globals
// the seed's policy allows; and the seed plus the three templates of 10.2 passes its own self-test.
// The seed half of A8 lives in `test/tidepool/modules.test.ts`.

import { describe, expect, it } from "vitest";
import { posix } from "node:path";
import { importSpecifiers, parseModule, usedGlobals } from "../modules.ts";
import { seedFiles, specBlock } from "../spec.ts";
import { verdictOf } from "./eval.ts";
import {
  JELLYFISH_FILE,
  RAY_FILE,
  SEAHORSE_FILE,
  crabFile,
  shrimpFile,
  squidFile,
} from "../../../src/swarm/casts/canned.ts";
import { tEnergy, tPlain, tRelative } from "../../../src/swarm/templates.ts";

/** The seeded generator of HO2, taken from the specification text and built by evaluating it. */
function makeReseed(): (n: number) => void {
  const source = specBlock("replace `Math.random` with the generator below", "```js");
  const build = new Function(`${source}\nreturn mulberry32;`) as () => (seed: number) => () => number;
  const mulberry32 = build();
  return (n: number): void => {
    Math.random = mulberry32(n);
  };
}

// The replace texts of 7.3 (the rescale) and 9.5 (P9a's two edits), quoted from the spec.
const ENERGY_OLD = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;
const ENERGY_NEW = `// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;`;
const DRAIN_OLD = `// Take energy away. \`amount\` is in the same unit as ENERGY_MAX.
export function drain(creature, amount) {
  creature.energy = Math.max(0, creature.energy - amount);
}`;
const DRAIN_NEW = `// Take energy away. \`percent\` is a share of a full tank in percent: 5 takes five percent of ENERGY_MAX.
export function drain(creature, percent) {
  creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);
}`;
const TICK_OLD = "  drain(creature, LIVING_COST);";
const TICK_NEW = "  drain(creature, (LIVING_COST / ENERGY_MAX) * 100);";

/** `world/energy.js` after P9a lands: R01's rescale, the percent `drain`, the percent tick. */
function energyAfterP9a(): string {
  let src = seedFiles().get("world/energy.js")!;
  for (const [old, next] of [
    [ENERGY_OLD, ENERGY_NEW],
    [DRAIN_OLD, DRAIN_NEW],
    [TICK_OLD, TICK_NEW],
  ] as const) {
    expect(src).toContain(old);
    src = src.replace(old, next);
  }
  return src;
}

/** The canned files of A8, at their tree paths: 7.3 (the hero casts), 8.2 and 8.6 (the second
 * catch), 9.5 (the sweep casts, both directions) and 10.5 (the same list), plus the post-P9a
 * `world/energy.js`. Every point-value and every fraction variant is included once. */
const CANNED: ReadonlyArray<[string, string]> = [
  ["creatures/crab.js", crabFile("30")],
  ["creatures/crab.js", crabFile("0.3")],
  ["creatures/shrimp.js", shrimpFile("5")],
  ["creatures/shrimp.js", shrimpFile("0.05")],
  ["creatures/jellyfish.js", JELLYFISH_FILE],
  ["creatures/seahorse.js", SEAHORSE_FILE],
  ["creatures/ray.js", RAY_FILE],
  ["creatures/squid.js", squidFile("0.1")],
  ["creatures/squid.js", squidFile("10")],
  ["world/energy.js", energyAfterP9a()],
];

describe("Appendix A, row A8 (the canned files)", () => {
  const files = seedFiles();
  const policy = JSON.parse(files.get(".premise/policy.json")!) as { globals: string[] };
  /** The seed with every canned variant overlaid at its path — the tree imports resolve against. */
  const tree = new Map(files);
  for (const [path, text] of CANNED) tree.set(path, text);

  const resolves = (fromFile: string, specifier: string): string | null => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    return target.startsWith("../") ? null : target;
  };

  it("every canned file parses with acorn", () => {
    for (const [path, text] of CANNED) {
      expect(() => parseModule(path, text), `${path} does not parse`).not.toThrow();
    }
  });

  it("every canned import resolves to a file of the pool", () => {
    const unresolved: string[] = [];
    for (const [path, text] of CANNED) {
      for (const entry of importSpecifiers(parseModule(path, text))) {
        const target = resolves(path, entry.specifier);
        if (target === null || !tree.has(target)) unresolved.push(`${path}:${entry.line} imports "${entry.specifier}"`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every global a canned file uses is in the policy's globals list", () => {
    const allowed = new Set(policy.globals);
    const outside: string[] = [];
    for (const [path, text] of CANNED) {
      for (const name of usedGlobals(parseModule(path, text))) {
        if (!allowed.has(name)) outside.push(`${path}: ${name}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("the post-P9a energy.js is the percent drain of 9.5", () => {
    const energy = tree.get("world/energy.js")!;
    expect(energy).toContain("export const ENERGY_MAX = 1;");
    expect(energy).toContain("creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);");
    expect(energy).toContain("drain(creature, (LIVING_COST / ENERGY_MAX) * 100);");
  });
});

describe("Appendix A, row A7 (the three templates of 10.2)", () => {
  it("the seed plus T-plain, T-energy and T-relative files passes its own self-test: `ok`", { timeout: 30_000 }, () => {
    const files = new Map(seedFiles());
    // The spec gives the templates but not file names or colours for this row; the names follow
    // 10.2's `s<number>.js` scheme and the palette/speeds of 10.2's own seed `tidepool-swarm`.
    files.set("creatures/s0004.js", tPlain("yellow", 2.5));
    files.set("creatures/s0005.js", tEnergy("silver", "30"));
    files.set("creatures/s0006.js", tRelative("orange"));
    const verdict = verdictOf(files, makeReseed());
    expect(verdict.ok).toBe(true);
    // All three kinds really spawned and ran (their rest shares are recorded by the self-test).
    expect(verdict.rest_share).toMatchObject({
      s0004: expect.any(Number),
      s0005: expect.any(Number),
      s0006: expect.any(Number),
    });
  });
});
