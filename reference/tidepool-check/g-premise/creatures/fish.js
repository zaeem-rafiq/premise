import { ENERGY_MAX, isHungry } from "../world/energy.js";
import { nearestFood } from "../world/food.js";
import { step, steer, glide } from "../world/movement.js";
import { wrap } from "../world/bounds.js";

const BODY = "gold";
const FIN = "#b8860b";

export function spawn() {
  return { vx: 1.5, energy: ENERGY_MAX };
}

export function update(fish, world) {
  const food = isHungry(fish) ? nearestFood(fish, world) : null;
  if (food) steer(fish, food.x, food.y, 0.2);
  else steer(fish, fish.x + (fish.vx < 0 ? -100 : 100), fish.y, 0.05);
  glide(fish, 0.98);
  step(fish);
  wrap(fish);
}

export function draw(fish, pen) {
  if (fish.vx < 0) pen.flip();
  pen.fill(FIN);
  pen.poly([-14, 0, -28, -11, -28, 11]);
  pen.fill(BODY);
  pen.ellipse(0, 0, 20, 11);
  pen.fill("black");
  pen.circle(10, -3, 2);
}
