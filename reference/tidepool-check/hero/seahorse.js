import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BODY = "pink";

export function spawn() {
  return { bob: 0 };
}

export function update(seahorse, world) {
  seahorse.bob = Math.sin(world.tick / 30 + seahorse.id);
  seahorse.y += seahorse.bob * 0.5;
  if (seahorse.y < SURFACE_Y + 30) seahorse.y = SURFACE_Y + 30;
  if (seahorse.y > FLOOR_Y - 30) seahorse.y = FLOOR_Y - 30;
}

export function draw(seahorse, pen) {
  pen.fill(BODY);
  pen.ellipse(0, 0, 8, 16);
  pen.circle(4, -18, 8);
  pen.line(10, -18, 18, -16);
  pen.arc(-2, 18, 8, 0, Math.PI);
}
