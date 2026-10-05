// The fixed file texts of the canned casts (02-tidepool.md 7.3, 8.2, 8.6, 9.5, 10.5), word for
// word. Where a creature file holds an energy number the text is a function of `v` — the
// `ENERGY_MAX` the agent last saw (its own read, or a heads-up's `after`) — so a refused write
// is decided again with the value the heads-up carried, and the canned file lands in the unit
// of the world it lands in.

/** `0.3 x v` as the literal the crab's threshold holds (`30` in points, `0.3` as a fraction). */
export function crabThreshold(v: number): string {
  return String((v * 3) / 10);
}

/** `5 percent of a tank` in the unit `v` is counted in (`5` in points, `0.05` as a fraction). */
export function dartCost(v: number): string {
  return String(v / 20);
}

/** The crab of 7.3: `crab.energy < 30` in points, `crab.energy < 0.3` as a fraction. */
export function crabFile(threshold: string): string {
  return `import { ENERGY_MAX } from "../world/energy.js";
import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "orange";

export function spawn() {
  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };
}

export function update(crab) {
  crab.hiding = crab.energy < ${threshold};
  if (crab.hiding) return;
  step(crab);
  bounce(crab);
}

export function draw(crab, pen) {
  pen.fill(SHELL);
  if (crab.hiding) {
    pen.ellipse(0, 2, 16, 9);
    return;
  }
  pen.line(-14, 6, -24, 14);
  pen.line(14, 6, 24, 14);
  pen.circle(-20, -10, 6);
  pen.circle(20, -10, 6);
  pen.ellipse(0, 0, 18, 11);
}
`;
}

/** The shrimp of 7.3: `drain(shrimp, 5)` in points, `drain(shrimp, 0.05)` as a fraction. */
export function shrimpFile(cost: string): string {
  return `import { ENERGY_MAX, drain } from "../world/energy.js";
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
    drain(shrimp, ${cost});
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
`;
}

/** The jellyfish of 7.3, verbatim. */
export const JELLYFISH_FILE = `import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

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
`;

/** The seahorse of 8.2, verbatim. */
export const SEAHORSE_FILE = `import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

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
`;

/** The ray of 10.5 (`wrap-b`), verbatim. */
export const RAY_FILE = `import { wrap } from "../world/bounds.js";
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
`;

/** The squid of 9.5: `drain(squid, 0.1)` while `drain` takes energy, `drain(squid, 10)` in percent. */
export function squidFile(cost: string): string {
  return `import { ENERGY_MAX, drain } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, wander, glide } from "../world/movement.js";

const BODY = "purple";

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(squid) {
  if (squid.age % seconds(3) === 0) {
    wander(squid, 3);
    drain(squid, ${cost});
  }
  glide(squid, 0.97);
  step(squid);
  bounce(squid);
}

export function draw(squid, pen) {
  if (squid.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(4, 0, 12, 8);
  pen.line(-8, -4, -22, -8);
  pen.line(-8, 0, -24, 0);
  pen.line(-8, 4, -22, 8);
}
`;
}
