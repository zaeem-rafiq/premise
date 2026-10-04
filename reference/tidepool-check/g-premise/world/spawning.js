import { POOL_WIDTH, SURFACE_Y, FLOOR_Y } from "./bounds.js";

// How many creatures of one kind the world makes when the creature file does not say.
export const SPAWN_PER_KIND = 3;

// The most creatures of one kind.
export const MAX_PER_KIND = 8;

// The most creatures in the pool. Kinds that come later in name order get none once the pool is full.
export const MAX_CREATURES = 150;

// How many creatures of this kind to make. A creature file may export `count`.
export function countFor(module) {
  const wanted = Number.isInteger(module.count) ? module.count : SPAWN_PER_KIND;
  return Math.min(MAX_PER_KIND, Math.max(1, wanted));
}

// Make one creature of `kind`. The creature file's spawn() gives its own starting values.
// The world fills in a random place in the water and no speed, and always sets kind, id, resting and age.
export function makeCreature(world, kind, module) {
  const own = module.spawn(world);
  const creature = {
    x: Math.random() * POOL_WIDTH,
    y: SURFACE_Y + Math.random() * (FLOOR_Y - SURFACE_Y),
    vx: 0,
    vy: 0,
    ...own,
    kind,
    id: world.nextId,
    resting: 0,
    age: 0,
  };
  world.nextId += 1;
  return creature;
}
