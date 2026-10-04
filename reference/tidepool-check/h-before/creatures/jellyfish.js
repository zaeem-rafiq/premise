import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BELL = "purple";

export function spawn() {
  return { vy: -0.4 };
}

export function update(jellyfish) {
  if (jellyfish.y < SURFACE_Y + 40) jellyfish.vy = 0.4;
  if (jellyfish.y > FLOOR_Y - 60) jellyfish.vy = -0.4;
  jellyfish.y += jellyfish.vy;
}

export function draw(jellyfish, pen) {
  pen.alpha(0.8);
  pen.fill(BELL);
  pen.ellipse(0, 0, 16, 10);
  pen.line(-8, 6, -8, 22);
  pen.line(0, 6, 0, 26);
  pen.line(8, 6, 8, 22);
}
