import { ENERGY_MAX, usesEnergy, isResting } from "../world/energy.js";
import { isInside } from "../world/bounds.js";
import { MAX_CREATURES, countFor } from "../world/spawning.js";
import { MAX_REACH } from "../pen.js";

// No kind may rest for more than this share of the run.
export const MAX_REST_SHARE = 0.25;

// What a creature draws must be at least this wide or tall, so it can be seen from the back of a room.
export const MIN_DRAWN = 16;

// The whole world, as text, must stay under this size.
export const MAX_STATE_CHARS = 200000;

// A short fingerprint of any plain value. Equal values give equal fingerprints.
export function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Checks on the creature files themselves.
export function checkFiles(kinds) {
  const bad = [];
  for (const kind of Object.keys(kinds).sort()) {
    for (const name of ["spawn", "update", "draw"]) {
      if (typeof kinds[kind][name] !== "function") bad.push(kind + ": " + name + " is missing");
    }
  }
  return bad;
}

// Checks after one tick. Adds to `tally` and returns the problems found this tick.
export function checkTick(world, kinds, tally) {
  const nowBad = [];
  for (const creature of world.creatures) {
    const kind = creature.kind;
    tally.ticks[kind] = (tally.ticks[kind] || 0) + 1;
    if (isResting(creature)) tally.resting[kind] = (tally.resting[kind] || 0) + 1;
    if (!isInside(creature.x, creature.y)) nowBad.push({ name: "in_bounds", kind });
    if (usesEnergy(creature) && !(creature.energy >= 0 && creature.energy <= ENERGY_MAX)) {
      nowBad.push({ name: "energy_range", kind });
    }
  }
  const expected = Object.keys(kinds)
    .filter((kind) => !world.benched[kind])
    .reduce((sum, kind) => sum + countFor(kinds[kind]), 0);
  if (world.creatures.length !== Math.min(MAX_CREATURES, expected)) nowBad.push({ name: "population", kind: null });
  return nowBad;
}

// Checks on one drawn frame. `report` comes from draw().
export function checkFrame(report) {
  const frameBad = [];
  for (const item of report) {
    if (item.rejected > 0) frameBad.push({ name: "pen_rules", kind: item.kind });
    const size = item.box === null ? 0 : Math.max(item.box[2] - item.box[0], item.box[3] - item.box[1]);
    if (size < MIN_DRAWN) frameBad.push({ name: "visible", kind: item.kind });
    if (item.box !== null && item.box.some((edge) => Math.abs(edge) > MAX_REACH)) {
      frameBad.push({ name: "within_reach", kind: item.kind });
    }
  }
  return frameBad;
}
