// The run plan of 6.2: `additive` A01 to A12 one run each, `hero` P1a and P1b five runs each —
// 22 runs per model. Intent texts come from `src/config/prewritten.ts` (generated from 02-tidepool
// section 9); the "Writes" column is copied from the same tables.

import { PREWRITTEN } from "../../../src/config/prewritten.ts";

export type IntentSpec = {
  id: string;
  text: string;
  set: "additive" | "hero";
  writes: string; // the file of the intent's "Writes" column
  readsEnergy: boolean; // the "Reads" column names `energy#ENERGY_MAX` (A08, A09, P1a, P1b)
  /** Hero only: the number the intent's own words carry, in points. */
  hero?: { oldNumber: number; newNumber: number };
};

const WRITES: Record<string, string> = {
  A01: "creatures/jellyfish.js",
  A02: "creatures/seahorse.js",
  A03: "creatures/starfish.js",
  A04: "creatures/urchin.js",
  A05: "creatures/manta.js",
  A06: "creatures/octopus.js",
  A07: "creatures/anglerfish.js",
  A08: "creatures/sardine.js",
  A09: "creatures/eel.js",
  A10: "creatures/pufferfish.js",
  A11: "creatures/lobster.js",
  A12: "creatures/cleaner.js",
  P1a: "creatures/crab.js",
  P1b: "creatures/shrimp.js",
};

const READS_ENERGY = new Set(["A08", "A09", "P1a", "P1b"]);

const textOf = (id: string): string => {
  const row = PREWRITTEN.find((r) => r.id === id);
  if (row === undefined) throw new Error(`unknown intent ${id}`);
  return row.text;
};

export const ADDITIVE_INTENTS: IntentSpec[] = [
  "A01",
  "A02",
  "A03",
  "A04",
  "A05",
  "A06",
  "A07",
  "A08",
  "A09",
  "A10",
  "A11",
  "A12",
].map((id) => ({
  id,
  text: textOf(id),
  set: "additive",
  writes: WRITES[id] as string,
  readsEnergy: READS_ENERGY.has(id),
}));

export const HERO_INTENTS: IntentSpec[] = [
  { id: "P1a", hero: { oldNumber: 30, newNumber: 0.3 } },
  { id: "P1b", hero: { oldNumber: 5, newNumber: 0.05 } },
].map(({ id, hero }) => ({
  id,
  text: textOf(id),
  set: "hero" as const,
  writes: WRITES[id] as string,
  readsEnergy: true,
  hero,
}));

export type RunSpec = { intent: IntentSpec; run: number };

/** The whole plan of 6.2; `--runs <n>` multiplies the per-intent run counts. */
export function runPlan(runsMultiplier = 1): RunSpec[] {
  const plan: RunSpec[] = [];
  for (const intent of ADDITIVE_INTENTS) {
    for (let i = 1; i <= 1 * runsMultiplier; i++) plan.push({ intent, run: i });
  }
  for (const intent of HERO_INTENTS) {
    for (let i = 1; i <= 5 * runsMultiplier; i++) plan.push({ intent, run: i });
  }
  return plan;
}
