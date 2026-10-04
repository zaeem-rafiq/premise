// `hero-c` (02-tidepool.md 7.3, 10.5): the canned row verbatim, the write's threshold follows
// the `ENERGY_MAX` source it was shown, and an E2 `repair` rewrites the landed text.

import { describe, expect, it } from "vitest";
import { crabFile } from "./canned.ts";
import { HERO_C } from "./hero-c.ts";
import { bag, entityDiff, hu, item, ok, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });
const ENERGY = E("world/energy.js#ENERGY_MAX");
const POINTS = "export const ENERGY_MAX = 100;";
const FRACTION = "export const ENERGY_MAX = 1;";

/** Run the script to its submit with the entity reads answered `ok`. */
function runToSubmit(b: ReturnType<typeof bag>, energySource = POINTS): void {
  step(HERO_C, b, null); // list
  step(HERO_C, b, ok()); // GUIDE.md
  step(HERO_C, b, ok({ source: energySource })); // energy#ENERGY_MAX
  step(HERO_C, b, ok());
  step(HERO_C, b, ok());
  step(HERO_C, b, ok()); // bounds, movement
}

describe("hero-c (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(HERO_C.id).toBe("hero-c");
    expect(HERO_C.intent).toBe("a crab that hides in its shell when its energy drops below 30");
    expect(HERO_C.truth).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "entity:world/bounds.js#FLOOR_Y",
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
    ]);
  });

  it("issues the calls of 7.3 in order and writes the crab with `crab.energy < 30`", () => {
    const b = bag();
    expect(step(HERO_C, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(HERO_C, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(HERO_C, b, ok({ source: POINTS }))).toMatchObject({
      tool: "read",
      args: { path: "world/energy.js", entity: "ENERGY_MAX" },
    });
    expect(step(HERO_C, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } });
    expect(step(HERO_C, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js", entity: "bounce" } });
    expect(step(HERO_C, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js", entity: "step" } });
    const w = step(HERO_C, b, ok());
    expect(w).toMatchObject({ tool: "write" });
    expect((w as { args: { content: string } }).args.content).toBe(crabFile("30"));
    expect(step(HERO_C, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("an `info` item showing the fraction before the write makes the write carry `0.3`", () => {
    const b = bag();
    step(HERO_C, b, null);
    step(HERO_C, b, ok());
    step(HERO_C, b, ok({ source: POINTS }), [hu(1, "info", [item(ENERGY, entityDiff(POINTS, FRACTION), "holds")])]);
    step(HERO_C, b, ok());
    step(HERO_C, b, ok());
    step(HERO_C, b, ok());
    const w = step(HERO_C, b, ok());
    expect((w as { args: { content: string } }).args.content).toBe(crabFile("0.3"));
  });

  it("an E2 `repair` after the write queues `30 -> 0.3` and acknowledges it", () => {
    const b = bag();
    runToSubmit(b);
    step(HERO_C, b, ok()); // write issued
    const next = step(HERO_C, b, ok(), [hu(1, "repair", [item(ENERGY, entityDiff(POINTS, FRACTION))])]);
    expect(next).toMatchObject({
      tool: "replace",
      args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" },
    });
    const s = step(HERO_C, b, ok());
    expect(s).toMatchObject({ kind: "tool", tool: "submit" });
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.",
    });
  });
});
