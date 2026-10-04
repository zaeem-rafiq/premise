import { describe, expect, it } from "vitest";
import { tEnergy } from "./templates.ts";
import { sw2Escapes } from "./sw2.ts";

const ENERGY_100 = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;

const ENERGY_1 = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;`;

const T_PLAIN = `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "teal";
const SPEED = 1;

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

describe("sw2 (02-tidepool.md 10.3 SW2)", () => {
  it("returns no escape when every T-energy threshold divided by ENERGY_MAX is 0.3", () => {
    const files = new Map<string, string>([
      ["world/energy.js", ENERGY_100],
      ["creatures/s0004.js", tEnergy("teal", "30")],
      ["creatures/s0000.js", T_PLAIN],
    ]);
    expect(sw2Escapes(files)).toEqual([]);
  });

  it("returns no escape for a rescaled world (30 -> 0.3, 100 -> 1)", () => {
    const files = new Map<string, string>([
      ["world/energy.js", ENERGY_1],
      ["creatures/s0004.js", tEnergy("teal", "0.3")],
    ]);
    expect(sw2Escapes(files)).toEqual([]);
  });

  it("lists every T-energy file whose threshold does not hold 0.3 of ENERGY_MAX", () => {
    const files = new Map<string, string>([
      ["world/energy.js", ENERGY_1],
      ["creatures/s0004.js", tEnergy("teal", "30")], // stale: 30 / 1
      ["creatures/s0005.js", tEnergy("red", "0.3")],
    ]);
    expect(sw2Escapes(files)).toEqual(["creatures/s0004.js"]);
  });

  it("skips a T-relative file (ENERGY_MAX * 0.3 is 0.3 by construction)", () => {
    const files = new Map<string, string>([
      ["world/energy.js", ENERGY_1],
      ["creatures/s0004.js", tEnergy("teal", "ENERGY_MAX * 0.3")],
    ]);
    expect(sw2Escapes(files)).toEqual([]);
  });

  it("counts a T-energy file when ENERGY_MAX is not parseable at head", () => {
    const files = new Map<string, string>([["creatures/s0004.js", tEnergy("teal", "30")]]);
    expect(sw2Escapes(files)).toEqual(["creatures/s0004.js"]);
  });
});
