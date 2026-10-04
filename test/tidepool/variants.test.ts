// The generated seeds of 02-tidepool.md section 6: `tidepool-auto` is the stored tree with the one
// policy line the section's table names; `tidepool-swarm` is that tree plus the four scripted
// creatures of 10.1, each the T-plain template of 10.2 with `{colour}` and `{speed}` filled in.
// The expected lines and the template come from the specification text.

import { describe, expect, it } from "vitest";
import { buildSeeds, readSeed } from "../../scripts/seeds/build.ts";
import { seedFiles, specBlock, specText } from "./spec.ts";

const seeds = buildSeeds(readSeed());
const base = seeds.get("tidepool") as ReadonlyMap<string, string>;
const automatic = seeds.get("tidepool-auto") as ReadonlyMap<string, string>;
const swarm = seeds.get("tidepool-swarm") as ReadonlyMap<string, string>;

/** The paths array section 6's table gives `tidepool-auto` for the first policy rule. */
function autoPaths(): string {
  const found = /`tidepool-auto`[^\n]*`(\[[^\]]+\])`/.exec(specText());
  if (found === null) throw new Error("section 6 does not name the tidepool-auto paths");
  return found[1] as string;
}

/** Line pairs (before, after) in which two texts differ; throws on unequal line counts. */
function differingLines(before: string, after: string): Array<{ old: string; new: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(a.length, "the variant changed the number of lines of the file").toBe(b.length);
  const pairs: Array<{ old: string; new: string }> = [];
  a.forEach((line, index) => {
    if (line !== b[index]) pairs.push({ old: line, new: b[index] as string });
  });
  return pairs;
}

/** The T-plain template of 10.2 with `{colour}` and `{speed}` filled in, as 10.1 names them. */
function expectedCreature(path: string): string {
  const details =
    /s0000\.js` to `s0003\.js` \(template T-plain below, colours `(\w+)`, `(\w+)`, `(\w+)`, `(\w+)`, speeds ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(
      specText(),
    );
  if (details === null) throw new Error("10.1 does not name the four scripted creatures");
  const number = Number(/^creatures\/s0*(\d+)\.js$/.exec(path)?.[1]);
  const colour = details[1 + number] as string;
  const speed = details[5 + number] as string;
  const block = specBlock("T-plain (file", "```js");
  return block.replaceAll("{colour}", colour).replaceAll("{speed}", speed);
}

describe("the generated seeds of 02-tidepool.md section 6", () => {
  it("builds the three seeds the section names", () => {
    expect([...seeds.keys()]).toEqual(["tidepool", "tidepool-auto", "tidepool-swarm"]);
  });

  it("tidepool is the stored tree", () => {
    expect(Object.fromEntries(base)).toEqual(Object.fromEntries(seedFiles()));
  });

  it("tidepool-auto holds the same files as the seed", () => {
    expect([...automatic.keys()]).toEqual([...base.keys()]);
  });

  it("tidepool-auto differs from the seed only in the one policy line section 6 names", () => {
    const changed = [...automatic.keys()].filter((path) => automatic.get(path) !== base.get(path));
    expect(changed).toEqual([".premise/policy.json"]);
    const diffs = differingLines(
      base.get(".premise/policy.json") as string,
      automatic.get(".premise/policy.json") as string,
    );
    expect(diffs.length).toBe(1);
    const { old: before, new: after } = diffs[0] as { old: string; new: string };
    expect(before).toContain('["creatures/*.js"]');
    expect(after).toContain(autoPaths());
    expect(after.replace(autoPaths(), '["creatures/*.js"]')).toBe(before);
  });

  it("tidepool-swarm is tidepool-auto plus the four scripted creatures of 10.1", () => {
    const added = [...swarm.keys()].filter((path) => !automatic.has(path));
    expect(added.sort()).toEqual(
      ["creatures/s0000.js", "creatures/s0001.js", "creatures/s0002.js", "creatures/s0003.js"].sort(),
    );
    const changed = [...automatic.keys()].filter((path) => swarm.get(path) !== automatic.get(path));
    expect(changed).toEqual([]);
  });

  it("each scripted creature of the swarm is the T-plain template of 10.2 filled in", () => {
    for (const path of ["s0000", "s0001", "s0002", "s0003"].map((name) => `creatures/${name}.js`)) {
      expect(swarm.get(path), `${path} is not the T-plain template of 10.2`).toBe(expectedCreature(path));
    }
  });
});
