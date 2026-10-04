// Check the Swarm creature templates of section 10 against the self-test and the policy globals.
import { mkdirSync, writeFileSync, cpSync } from "node:fs";
const dir = "pool-swarm-" + Date.now();
cpSync("pool2", dir, { recursive: true });
const plain = (colour, speed) => `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "${colour}";
const SPEED = ${speed};

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;
const energy = (colour, threshold) => `import { ENERGY_MAX } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const BODY = "${colour}";

export function spawn() {
  return { vx: 1, vy: 0.5, energy: ENERGY_MAX };
}

export function update(creature) {
  if (creature.energy < ${threshold}) return;
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.rect(-9, -9, 18, 18, 4);
}
`;
writeFileSync(dir + "/creatures/s0000.js", plain("teal", 1));
writeFileSync(dir + "/creatures/s0001.js", plain("red", 1.5));
writeFileSync(dir + "/creatures/s0002.js", energy("blue", "30"));
writeFileSync(dir + "/creatures/s0003.js", energy("green", "ENERGY_MAX * 0.3"));
console.log(dir);
