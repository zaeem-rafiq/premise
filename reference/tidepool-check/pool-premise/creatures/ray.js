import { wrap } from "../world/bounds.js";
import { step } from "../world/movement.js";

const WINGS = "blue";

export function spawn() {
  return { vx: 2 };
}

export function update(ray) {
  step(ray);
  wrap(ray);
}

export function draw(ray, pen) {
  if (ray.vx < 0) pen.flip();
  pen.fill(WINGS);
  pen.poly([24, 0, -6, -18, -14, 0, -6, 18]);
  pen.line(-14, 0, -34, 0);
}
