// The collision dial of 02-tidepool.md 10.4: `collision_dial` is a number `d` from 0 to 1. For
// each launched agent one draw `u` from its generator decides its class — colliding when
// `u < d`, independent when `u >= d` — and a second draw `v` picks the pattern by weight.
// `rescale-energy` is never drawn: one is launched every `rescale_every_s` seconds while
// `d > 0` (the launcher's schedule, not a row of the table).
//
// Pure (SY1/SY2): the two draws come from the passed `rand` — the agent's generator
// `agentRandom(seed, n)` — and the answer is a pattern id of 10.3. The same `SwarmConfig` gives
// the same mix because the same `(seed, n)` gives the same draws (SW1).

import { patternById } from "./pattern.ts";

/** The independent class of the 10.4 table, in the row's order; the weights sum to 1. */
export const INDEPENDENT_WEIGHTS: ReadonlyArray<{ id: string; weight: number }> = [
  { id: "add-plain", weight: 0.85 },
  { id: "reader", weight: 0.1 },
  { id: "blind", weight: 0.05 },
];

/** The colliding class of the 10.4 table, in the row's order; the weights sum to 1. */
export const COLLIDING_WEIGHTS: ReadonlyArray<{ id: string; weight: number }> = [
  { id: "add-energy", weight: 0.35 },
  { id: "edit-creature", weight: 0.2 },
  { id: "retune", weight: 0.15 },
  { id: "add-relative", weight: 0.1 },
  { id: "sweep-colour", weight: 0.05 },
  { id: "sweep-search", weight: 0.05 },
  { id: "same-file", weight: 0.05 },
  { id: "cosmetic", weight: 0.05 },
];

/**
 * The pattern one agent plays at dial `d`: the first draw of `rand` decides the class
 * (`u < d` colliding, `u >= d` independent), the second picks the pattern by weight — the
 * cumulative weights of the class's row, in table order. Returns the pattern id.
 */
export function dialPattern(d: number, rand: () => number): string {
  const u = rand();
  const v = rand();
  const table = u < d ? COLLIDING_WEIGHTS : INDEPENDENT_WEIGHTS;
  // The weights are multiples of 0.05; accumulating in hundredths keeps the boundaries exact
  // (a `v` exactly on a boundary takes the next row's range).
  let acc = 0;
  for (const { id, weight } of table) {
    acc += Math.round(weight * 100);
    if (v < acc / 100) return id;
  }
  return (table[table.length - 1] as { id: string }).id;
}

/** `dialPattern` resolved to the registered `Pattern` (10.3). */
export function dialPick(d: number, rand: () => number) {
  const id = dialPattern(d, rand);
  const pattern = patternById(id);
  if (pattern === undefined) throw new Error(`dial: ${id} is not a registered pattern`);
  return pattern;
}
