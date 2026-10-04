import { ENERGY_MAX } from "../world/energy.js";
import { step, steer, wander, glide } from "../world/movement.js";
import { bounce } from "../world/bounds.js";

const BODY = "gold";

// Minnows come as a school of six.
export const count = 6;

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(minnow, world) {
  const leader = world.creatures.find((other) => other.kind === "minnow");
  if (leader && leader !== minnow) steer(minnow, leader.x, leader.y, 0.08);
  wander(minnow, 0.15);
  glide(minnow, 0.95);
  step(minnow);
  bounce(minnow);
}

export function draw(minnow, pen) {
  if (minnow.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(0, 0, 9, 4);
  pen.poly([-7, 0, -14, -5, -14, 5]);
}
