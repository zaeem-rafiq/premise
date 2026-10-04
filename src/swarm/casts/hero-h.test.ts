// `hero-h` (02-tidepool.md 7.3, 10.5): the canned row verbatim, the write's dart cost follows
// the `ENERGY_MAX` source it was shown — through an entity diff or through the added lines of
// the file diff of an X0/F4 `info` (H reads whole files) — and an E2 `repair` rewrites a
// recorded `drain(shrimp, 5)`.

import { describe, expect, it } from "vitest";
import { shrimpFile } from "./canned.ts";
import { HERO_H } from "./hero-h.ts";
import { bag, entityDiff, fileDiff, hu, item, ok, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });
const F = (key: string) => ({ kind: "file" as const, key });
const ENERGY = E("world/energy.js#ENERGY_MAX");
const POINTS = "export const ENERGY_MAX = 100;";
const FRACTION = "export const ENERGY_MAX = 1;";
const UNIFIED = "@@ -1,2 +1,2 @@\n-export const ENERGY_MAX = 100;\n+export const ENERGY_MAX = 1;";

describe("hero-h (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(HERO_H.id).toBe("hero-h");
    expect(HERO_H.intent).toBe("a shrimp that darts every two seconds and spends 5 energy on each dart");
    expect(HERO_H.truth).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "entity:world/energy.js#drain",
      "entity:world/bounds.js#bounce",
      "entity:world/time.js#seconds",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
      "entity:world/movement.js#glide",
    ]);
  });

  it("issues the calls of 7.3 in order and writes the shrimp with `drain(shrimp, 5)`", () => {
    const b = bag();
    expect(step(HERO_H, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(HERO_H, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(HERO_H, b, ok({ content: POINTS }))).toMatchObject({ tool: "read", args: { path: "world/energy.js" } });
    expect(step(HERO_H, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js" } });
    expect(step(HERO_H, b, ok())).toMatchObject({ tool: "read", args: { path: "world/time.js" } });
    expect(step(HERO_H, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js" } });
    const w = step(HERO_H, b, ok());
    expect((w as { args: { content: string } }).args.content).toBe(shrimpFile("5"));
    expect(step(HERO_H, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("an `info` file diff showing the fraction before the write makes the write carry `0.05`", () => {
    const b = bag();
    step(HERO_H, b, null); step(HERO_H, b, ok());
    step(HERO_H, b, ok({ content: POINTS }), [
      hu(1, "info", [item(F("world/energy.js"), fileDiff(UNIFIED, ["world/energy.js#ENERGY_MAX"]), "holds")]),
    ]);
    step(HERO_H, b, ok()); step(HERO_H, b, ok()); step(HERO_H, b, ok());
    const w = step(HERO_H, b, ok());
    expect((w as { args: { content: string } }).args.content).toBe(shrimpFile("0.05"));
  });

  it("an E2 `repair` after the write queues `5 -> 0.05` and acknowledges it", () => {
    const b = bag();
    step(HERO_H, b, null); step(HERO_H, b, ok()); step(HERO_H, b, ok({ content: POINTS }));
    step(HERO_H, b, ok()); step(HERO_H, b, ok()); step(HERO_H, b, ok());
    step(HERO_H, b, ok()); // write issued with drain(shrimp, 5)
    const next = step(HERO_H, b, ok(), [
      hu(1, "repair", [item(ENERGY, entityDiff(POINTS, FRACTION))]),
    ]);
    expect(next).toMatchObject({
      tool: "replace",
      args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" },
    });
    const s = step(HERO_H, b, ok());
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "Energy is now a fraction from 0 to 1, so a dart costs 0.05.",
    });
  });
});
