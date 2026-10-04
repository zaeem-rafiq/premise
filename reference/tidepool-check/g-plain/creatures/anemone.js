import { FLOOR_Y } from "../world/bounds.js";
import { isNight } from "../world/time.js";

const ARMS = "gold";
const BASE = "#b8860b";

export function spawn() {
  return { y: FLOOR_Y - 6, open: true, sway: 0 };
}

export function update(anemone, world) {
  anemone.open = !isNight(world);
  anemone.sway = Math.sin(world.tick / 40 + anemone.id) * 4;
}

export function draw(anemone, pen) {
  pen.fill(BASE);
  pen.rect(-10, -6, 20, 12, 4);
  pen.stroke(ARMS, 4);
  const reach = anemone.open ? 26 : 10;
  for (let arm = -2; arm <= 2; arm += 1) {
    pen.line(arm * 4, -6, arm * 7 + anemone.sway, -6 - reach);
  }
}
