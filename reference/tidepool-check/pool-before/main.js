import { createWorld, populate, tickWorld, drawWorld } from "./world/rules.js";
import { isResting } from "./world/energy.js";
import { distance } from "./world/movement.js";
import { POOL_WIDTH, POOL_HEIGHT } from "./world/bounds.js";

// A tap within this distance of a creature picks it.
export const TAP_RADIUS = 30;

// The size of the pool in pool units. The page scales the picture to fit.
export function poolSize() {
  return { width: POOL_WIDTH, height: POOL_HEIGHT };
}

// Start a pool. `kinds` maps each kind name to its creature file.
export function createPool(kinds) {
  const pool = { world: createWorld(), kinds };
  populate(pool.world, kinds);
  return pool;
}

// Carry a running pool over to new creature files.
// Creatures of a kind in `changed`, and creatures whose kind is gone, are removed. New and changed kinds are made again.
export function adoptPool(pool, kinds, changed) {
  const world = pool.world;
  world.creatures = world.creatures.filter((creature) => kinds[creature.kind] && !changed.includes(creature.kind));
  world.errors = {};
  world.benched = {};
  populate(world, kinds);
  return { world, kinds };
}

// One tick.
export function tick(pool) {
  tickWorld(pool.world, pool.kinds);
}

// One frame. `control` comes from createPen(surface).
export function draw(pool, control) {
  return drawWorld(pool.world, pool.kinds, control);
}

// The creature nearest to the point, or null when none is within TAP_RADIUS.
export function creatureAt(pool, x, y) {
  let best = null;
  let bestFar = TAP_RADIUS;
  for (const creature of pool.world.creatures) {
    const far = distance(creature, { x, y });
    if (far <= bestFar) {
      best = { kind: creature.kind, id: creature.id };
      bestFar = far;
    }
  }
  return best;
}

// Numbers for the people watching: how many of each kind, how many are resting, which kinds failed.
export function stats(pool) {
  const kinds = {};
  for (const kind of Object.keys(pool.kinds).sort()) {
    kinds[kind] = { count: 0, resting: 0, errors: pool.world.errors[kind] || 0, benched: Boolean(pool.world.benched[kind]) };
  }
  for (const creature of pool.world.creatures) {
    if (!kinds[creature.kind]) continue;
    kinds[creature.kind].count += 1;
    if (isResting(creature)) kinds[creature.kind].resting += 1;
  }
  return { tick: pool.world.tick, food: pool.world.food.length, kinds };
}
