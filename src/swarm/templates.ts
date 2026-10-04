// The creature templates of 02-tidepool.md 10.2 and the pick-lists the canned patterns draw from
// (SW1). Pure text builders: no clock and no chance of their own (SY1, SY2); every draw comes
// from the agent's `rand` at the call site.

/** The colour names of `PALETTE` (02 3.1), in spec order. One draw chooses the creature's colour. */
export const PALETTE = [
  "white",
  "black",
  "grey",
  "silver",
  "red",
  "orange",
  "yellow",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
  "sand",
] as const;

/** The speeds the scripted creatures of the seed use (02 10.1): the cycle `edit-creature` steps. */
export const SPEEDS = [1, 1.5, 2, 2.5] as const;

/** T-plain of `02` 10.2 with `{colour}` and `{speed}` filled in. */
export function tPlain(colour: string, speed: number): string {
  return `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "${colour}";
const SPEED = ${speed};

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;
}

/** T-energy of `02` 10.2 with `{colour}` and `{threshold}` filled in. */
export function tEnergy(colour: string, threshold: string): string {
  return `import { ENERGY_MAX } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const BODY = "${colour}";

export function spawn() {
  return { vx: 1, vy: 0.5, energy: ENERGY_MAX };
}

export function update(creature) {
  if (creature.energy < ${threshold}) return;
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.rect(-9, -9, 18, 18, 4);
}
`;
}

/** T-relative of `02` 10.2: T-energy with `{threshold}` replaced by the text `ENERGY_MAX * 0.3`. */
export function tRelative(colour: string): string {
  return tEnergy(colour, "ENERGY_MAX * 0.3");
}
