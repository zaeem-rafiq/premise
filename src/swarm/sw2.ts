// The SW2 oracle (02-tidepool.md 10.3): after a run, for every landed file made from T-energy,
// the threshold number divided by `ENERGY_MAX` at head MUST be 0.3. Each file that fails is one
// escape. It is checked from the final tree, independent of Trunk's own judgments: this function
// is given the tree and returns the offending paths.

import { energyMaxOf } from "./scripted.ts";

/** A T-energy file: imports `ENERGY_MAX` from `../world/energy.js`. */
const T_ENERGY_IMPORT = /import\s*\{[^}]*\bENERGY_MAX\b[^}]*\}\s*from\s*["']\.\.\/world\/energy\.js["']/;

/** The T-energy threshold line with a number: `creature.energy < 30`. T-relative's
 * `creature.energy < ENERGY_MAX * 0.3` does not match, and is 0.3 by construction. */
const THRESHOLD = /creature\.energy\s*<\s*(\d+(?:\.\d+)?)/;

/**
 * The paths of the T-energy files whose `creature.energy < n` fails `n / ENERGY_MAX = 0.3`,
 * sorted. A T-energy file in a tree without a parseable `ENERGY_MAX` is an escape (the ratio
 * cannot hold).
 */
export function sw2Escapes(files: ReadonlyMap<string, string>): string[] {
  const max = energyMaxOf(files.get("world/energy.js"));
  const escapes: string[] = [];
  for (const [path, content] of files) {
    if (!T_ENERGY_IMPORT.test(content)) continue;
    const match = THRESHOLD.exec(content);
    if (match === null) continue;
    if (max === null || Math.abs(Number(match[1]) / max - 0.3) > 1e-9) escapes.push(path);
  }
  return escapes.sort();
}
