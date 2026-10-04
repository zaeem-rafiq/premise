import { ENERGY_MAX, isHungry } from "../world/energy.js";
import { nearestFood } from "../world/food.js";
import { SURFACE_Y, POOL_HEIGHT, bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, steer, glide } from "../world/movement.js";

const SHELL = "gold";
const SKIN = "#b8860b";

// Two turtles are enough.
export const count = 2;

export function spawn() {
  return { vx: 0.5, energy: ENERGY_MAX };
}

export function update(turtle, world) {
  const needsAir = turtle.age % seconds(20) < seconds(4);
  const food = isHungry(turtle) ? nearestFood(turtle, world) : null;
  if (needsAir) steer(turtle, turtle.x, SURFACE_Y, 0.1);
  else if (food) steer(turtle, food.x, food.y, 0.1);
  else steer(turtle, turtle.x + (turtle.vx < 0 ? -80 : 80), POOL_HEIGHT / 2, 0.03);
  glide(turtle, 0.96);
  step(turtle);
  bounce(turtle);
}

export function draw(turtle, pen) {
  if (turtle.vx < 0) pen.flip();
  pen.fill(SKIN);
  pen.circle(24, -2, 7);
  pen.ellipse(-12, 12, 8, 4, 0.5);
  pen.ellipse(12, 12, 8, 4, -0.5);
  pen.fill(SHELL);
  pen.ellipse(0, 0, 22, 14);
}
