// The pool is POOL_WIDTH wide and POOL_HEIGHT tall, in pool units. x grows to the right, y grows downward.
export const POOL_WIDTH = 800;
export const POOL_HEIGHT = 500;

// The water line. Above it is sky.
export const SURFACE_Y = 40;

// The top of the sand. Below it is sand.
export const FLOOR_Y = 460;

// True when the point is in the water.
export function isInside(x, y) {
  return x >= 0 && x <= POOL_WIDTH && y >= SURFACE_Y && y <= FLOOR_Y;
}

// Stop at the edges of the water.
export function keepInside(creature) {
  creature.x = Math.min(POOL_WIDTH, Math.max(0, creature.x));
  creature.y = Math.min(FLOOR_Y, Math.max(SURFACE_Y, creature.y));
}

// Turn around at the edges of the water.
export function bounce(creature) {
  if (creature.x < 0 || creature.x > POOL_WIDTH) creature.vx = -creature.vx;
  if (creature.y < SURFACE_Y || creature.y > FLOOR_Y) creature.vy = -creature.vy;
  keepInside(creature);
}

// Leave through one side wall and come back in through the other.
export function wrap(creature) {
  if (creature.x < 0) creature.x += POOL_WIDTH;
  if (creature.x > POOL_WIDTH) creature.x -= POOL_WIDTH;
  creature.y = Math.min(FLOOR_Y, Math.max(SURFACE_Y, creature.y));
}
