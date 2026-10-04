import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "gold";
const BODY = "#b8860b";

export function spawn() {
  return { y: FLOOR_Y - 8, vx: 0.2 };
}

export function update(snail) {
  step(snail);
  bounce(snail);
}

export function draw(snail, pen) {
  if (snail.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.rect(-14, 2, 30, 7, 3);
  pen.fill(SHELL);
  pen.circle(-2, -4, 11);
  pen.line(16, 2, 20, -8);
}
