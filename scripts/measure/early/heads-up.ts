// The scripted heads-up of ME5 (set `hero`): after a run's first passing `submit` the script lands
// the shared-rule change of 02-tidepool 7.1 on `world/energy.js` and builds the `HeadsUp` of
// 05-agent 3.8 — `hn` 1, result `repair`, `wake: true`, cause `landing`, one item of rule `E2` on
// `entity:world/energy.js#ENERGY_MAX`, and `uses` every line of the run's creature file that holds
// the identifier `ENERGY_MAX`.

import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { parseModule, entityByName } from "./entities.ts";

export const ENERGY_PATH = "world/energy.js";
export const ENERGY_ENTITY = `${ENERGY_PATH}#ENERGY_MAX`;

/** The two lines of the shared-rule change (02-tidepool 7.1), before and after. */
export const ENERGY_BEFORE =
  "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
export const ENERGY_AFTER =
  "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";

export const HERO_INTENT_TEXT = "make energy a fraction from 0 to 1";

/** ME5 step 2: `world/energy.js` at head after the scripted landing (first two lines swapped). */
export function landEnergyChange(source: string): string {
  if (!source.startsWith(ENERGY_BEFORE)) {
    return ENERGY_AFTER + source.slice(source.indexOf("\n", source.indexOf("\n") + 1));
  }
  return ENERGY_AFTER + source.slice(ENERGY_BEFORE.length);
}

/** `true` when `source` holds the identifier `ENERGY_MAX` outside its import lines (ME5's test). */
export function referencesEnergyMax(source: string): boolean {
  const needle = /\bENERGY_MAX\b/;
  return source.split("\n").some((line) => !line.trimStart().startsWith("import") && needle.test(line));
}

/**
 * Every line of `source` that holds the identifier `ENERGY_MAX`, as `uses` entries (ME5 step 3):
 * path, containing entity, 1-based line and the text unchanged. A line in an import declaration's
 * region is named by its `(import <specifier>)` entity.
 */
export function energyUses(
  path: string,
  source: string,
): Array<{ path: string; entity: string; line: number; text: string }> {
  const mod = parseModule(path, source);
  const lines = source.split("\n");
  const uses: Array<{ path: string; entity: string; line: number; text: string }> = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const lineOffset = offset;
    offset += text.length + 1;
    if (!/\bENERGY_MAX\b/.test(text)) continue;
    let entity = "(top)";
    if (mod.ok) {
      const at = mod.entities.find((e) => e.regions.some(([rs, re]) => lineOffset >= rs && lineOffset < re));
      if (at !== undefined) entity = at.name;
    }
    uses.push({ path, entity, line: i + 1, text });
  }
  return uses;
}

/** The normalized entity hash of 01-core 2.4 for `ENERGY_MAX` in `source` (as the spec prints it). */
function energyHash(source: string): string {
  const m = parseModule(ENERGY_PATH, source + "\n");
  const e = m.ok ? entityByName(m, "ENERGY_MAX") : null;
  if (e === null || e === undefined) throw new Error("ENERGY_MAX not found in scripted energy source");
  return e.hash;
}

/**
 * The `HeadsUp` of 05-agent 3.8 for the scripted landing, or `null` when the creature file has no
 * `ENERGY_MAX` line: the product would send none (HC3 (a)), and the run scores `no_reference`.
 */
export function buildHeroHeadsUp(opts: {
  attemptId: string;
  creaturePath: string;
  creatureSource: string;
  now: number;
}): HeadsUp | null {
  const uses = energyUses(opts.creaturePath, opts.creatureSource);
  if (uses.length === 0) return null;
  return {
    hn: 1,
    attempt_id: opts.attemptId,
    result: "repair",
    wake: true,
    cause: {
      type: "landing",
      seqs: [1],
      changes: [{ seq: 1, change_id: `c_${opts.attemptId}_rescale`, intent_text: HERO_INTENT_TEXT }],
    },
    items: [
      {
        premise: { kind: "entity", key: ENERGY_ENTITY },
        rule: "E2",
        result: "repair",
        reason: "referenced_entity_changed",
        old_hash: energyHash(ENERGY_BEFORE),
        new_hash: energyHash(ENERGY_AFTER),
        cause_seq: 1,
        diff: { kind: "entity", before: ENERGY_BEFORE, after: ENERGY_AFTER },
        uses,
      },
    ],
    dropped_ops: [],
    go_around: 1,
    head_seq: 1,
    created_at: opts.now,
  };
}
