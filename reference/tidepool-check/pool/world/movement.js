// Speed is counted in pool units per tick.
export const MAX_SPEED = 3;

// Move the creature by its speed (vx, vy), never faster than MAX_SPEED.
export function step(creature) {
  const speed = Math.hypot(creature.vx, creature.vy);
  if (speed > MAX_SPEED) {
    creature.vx = (creature.vx / speed) * MAX_SPEED;
    creature.vy = (creature.vy / speed) * MAX_SPEED;
  }
  creature.x += creature.vx;
  creature.y += creature.vy;
}

// Push the creature toward the point (x, y). `push` is the speed added this tick.
export function steer(creature, x, y, push) {
  const dx = x - creature.x;
  const dy = y - creature.y;
  const far = Math.hypot(dx, dy);
  if (far < 0.001) return;
  creature.vx += (dx / far) * push;
  creature.vy += (dy / far) * push;
}

// Push the creature in a random direction. `push` is the speed added this tick.
export function wander(creature, push) {
  const angle = Math.random() * 2 * Math.PI;
  creature.vx += Math.cos(angle) * push;
  creature.vy += Math.sin(angle) * push;
}

// Slow down. `keep` is the share of speed kept this tick, for example 0.95.
export function glide(creature, keep) {
  creature.vx *= keep;
  creature.vy *= keep;
}

// How far apart two things with x and y are.
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
