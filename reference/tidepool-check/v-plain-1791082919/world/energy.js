// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;

// What one tick of ordinary living costs.
export const LIVING_COST = ENERGY_MAX / 3600;

// A creature below this level is hungry.
export const HUNGRY_BELOW = ENERGY_MAX / 2;

// An empty creature rests for this many ticks, then wakes up full.
export const REST_TICKS = 300;

// True when the creature takes part in the energy rules.
// A creature takes part when its spawn function sets `energy`.
export function usesEnergy(creature) {
  return typeof creature.energy === "number";
}

// Take energy away. `amount` is in the same unit as ENERGY_MAX.
export function drain(creature, amount) {
  creature.energy = Math.max(0, creature.energy - amount);
}

// Give energy. `amount` is in the same unit as ENERGY_MAX.
export function feed(creature, amount) {
  creature.energy = Math.min(ENERGY_MAX, creature.energy + amount);
}

// True when the creature is below HUNGRY_BELOW.
export function isHungry(creature) {
  return creature.energy < HUNGRY_BELOW;
}

// True while an empty creature is resting. The world does not update a resting creature.
export function isResting(creature) {
  return creature.resting > 0;
}

// Called by the world once per tick for every creature that uses energy.
export function liveOneTick(creature) {
  if (creature.resting > 0) {
    creature.resting -= 1;
    if (creature.resting === 0) creature.energy = ENERGY_MAX;
    return;
  }
  drain(creature, LIVING_COST);
  if (creature.energy <= 0) creature.resting = REST_TICKS;
}
