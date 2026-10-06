// The engine plan of 6.2: `additive` A01 to A12, `hero` P1a and P1b (five runs each), `confirm`
// P3a (three runs), `shared` R01 to R12 — 37 runs for the workhorse; `--sets additive,hero` gives
// the 22 runs of another race model. Intent texts come from `src/config/prewritten.ts`; the
// "Writes" column is copied from the tables of 02-tidepool section 9.

import { PREWRITTEN } from "../../../src/config/prewritten.ts";
import { ADDITIVE_INTENTS, HERO_INTENTS, type IntentSpec, type RunSpec } from "../early/intents.ts";

export type SetName = "additive" | "hero" | "confirm" | "shared";
export const SET_NAMES: readonly SetName[] = ["additive", "hero", "confirm", "shared"];

const textOf = (id: string): string => {
  const row = PREWRITTEN.find((r) => r.id === id);
  if (row === undefined) throw new Error(`unknown intent ${id}`);
  return row.text;
};

/** The file the intent's "Writes" column names (9.2, 9.3). */
const WRITES: Record<string, string> = {
  P3a: "creatures/fish.js",
  R01: "world/energy.js",
  R02: "world/time.js",
  R03: "world/movement.js",
  R04: "world/bounds.js",
  R05: "world/food.js",
  R06: "world/bounds.js",
  R07: "world/energy.js",
  R08: "world/food.js",
  R09: "world/time.js",
  R10: "world/energy.js",
  R11: "world/rules.js",
  R12: "world/scene.js",
};

export const CONFIRM_INTENTS: IntentSpec[] = [
  { id: "P3a", text: textOf("P3a"), set: "confirm", writes: WRITES.P3a as string, readsEnergy: false },
];

export const SHARED_INTENTS: IntentSpec[] = [
  "R01",
  "R02",
  "R03",
  "R04",
  "R05",
  "R06",
  "R07",
  "R08",
  "R09",
  "R10",
  "R11",
  "R12",
].map((id) => ({
  id,
  text: textOf(id),
  set: "shared" as const,
  writes: WRITES[id] as string,
  readsEnergy: false,
}));

const SET_INTENTS: Record<SetName, { intents: IntentSpec[]; runsEach: number }> = {
  additive: { intents: ADDITIVE_INTENTS, runsEach: 1 },
  hero: { intents: HERO_INTENTS, runsEach: 5 },
  confirm: { intents: CONFIRM_INTENTS, runsEach: 3 },
  shared: { intents: SHARED_INTENTS, runsEach: 1 },
};

/** The engine plan for the chosen sets, in the table's set order; `--runs <n>` multiplies. */
export function enginePlan(sets: readonly SetName[], runsMultiplier = 1): RunSpec[] {
  const plan: RunSpec[] = [];
  for (const name of SET_NAMES) {
    if (!sets.includes(name)) continue;
    const { intents, runsEach } = SET_INTENTS[name];
    for (const intent of intents) {
      for (let i = 1; i <= runsEach * runsMultiplier; i++) plan.push({ intent, run: i });
    }
  }
  return plan;
}
