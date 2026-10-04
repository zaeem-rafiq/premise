import { ENERGY_MAX, feed } from "./energy.js";
import { POOL_WIDTH, SURFACE_Y, FLOOR_Y } from "./bounds.js";

// What one pellet of food is worth.
export const FOOD_ENERGY = ENERGY_MAX / 4;

// A new pellet drops every FOOD_EVERY ticks.
export const FOOD_EVERY = 30;

// Pellets sink this fast, in pool units per tick.
export const FOOD_SINK = 0.6;

// A pellet that nobody eats dissolves after this many ticks.
export const FOOD_LIFE = 1500;

// A creature eats a pellet that is this close.
export const EAT_RADIUS = 16;

// Called by the world once per tick: drop a new pellet when it is time, sink and dissolve the others.
export function moveFood(world) {
  if (world.tick % FOOD_EVERY === 0) {
    world.food.push({ x: Math.random() * POOL_WIDTH, y: SURFACE_Y, age: 0 });
  }
  for (const pellet of world.food) {
    pellet.y = Math.min(FLOOR_Y, pellet.y + FOOD_SINK);
    pellet.age += 1;
  }
  world.food = world.food.filter((pellet) => pellet.age < FOOD_LIFE);
}

// The pellet closest to the creature, or null when there is none.
export function nearestFood(creature, world) {
  let best = null;
  let bestFar = Infinity;
  for (const pellet of world.food) {
    const far = Math.hypot(pellet.x - creature.x, pellet.y - creature.y);
    if (far < bestFar) {
      best = pellet;
      bestFar = far;
    }
  }
  return best;
}

// Called by the world once per tick for every creature that uses energy.
// The creature eats one pellet within EAT_RADIUS. Returns true when it ate.
export function eatNearby(creature, world) {
  for (let i = 0; i < world.food.length; i += 1) {
    const pellet = world.food[i];
    if (Math.hypot(pellet.x - creature.x, pellet.y - creature.y) <= EAT_RADIUS) {
      world.food.splice(i, 1);
      feed(creature, FOOD_ENERGY);
      return true;
    }
  }
  return false;
}
