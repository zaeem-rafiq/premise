import { POOL_WIDTH, POOL_HEIGHT, SURFACE_Y, FLOOR_Y } from "./bounds.js";
import { isNight } from "./time.js";

// Draw the sky, the water and the sand.
export function drawScene(world, pen) {
  const night = isNight(world);
  pen.stroke(null);
  pen.fill(night ? "#0b1d33" : "#bfe6ff");
  pen.rect(0, 0, POOL_WIDTH, SURFACE_Y);
  pen.fill(night ? "#0f3550" : "#1c7fa6");
  pen.rect(0, SURFACE_Y, POOL_WIDTH, FLOOR_Y - SURFACE_Y);
  pen.fill("sand");
  pen.rect(0, FLOOR_Y, POOL_WIDTH, POOL_HEIGHT - FLOOR_Y);
}

// Draw every food pellet.
export function drawFood(world, pen) {
  pen.stroke(null);
  pen.fill("yellow");
  for (const pellet of world.food) pen.circle(pellet.x, pellet.y, 3);
}

// A creature that has just arrived gets a ring around it for this many ticks.
export const ARRIVAL_TICKS = 90;

// Draw the ring around a creature that has just arrived.
export function drawArrival(creature, pen) {
  if (creature.age >= ARRIVAL_TICKS) return;
  const done = creature.age / ARRIVAL_TICKS;
  pen.fill(null);
  pen.stroke("white", 3);
  pen.alpha(1 - done);
  pen.circle(creature.x, creature.y, 14 + done * 40);
  pen.alpha(1);
}
