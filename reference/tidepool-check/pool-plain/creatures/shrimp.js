import { ENERGY_MAX, drain } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, wander, glide } from "../world/movement.js";

const BODY = "pink";

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(shrimp) {
  if (shrimp.age % seconds(2) === 0) {
    wander(shrimp, 3);
    drain(shrimp, 5);
  }
  glide(shrimp, 0.95);
  step(shrimp);
  bounce(shrimp);
}

export function draw(shrimp, pen) {
  if (shrimp.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(0, 0, 14, 6);
  pen.poly([-12, 0, -22, -7, -22, 7]);
  pen.line(12, -2, 24, -10);
  pen.line(12, 0, 26, -4);
}
