// `sweep-b` (02-tidepool.md 9.5, 10.5): the canned row verbatim; the squid's burst is
// `drain(squid, 0.1)` while `drain` takes energy and `drain(squid, 10)` once an E2 `repair`
// shows the `percent` drain — before or after the write (the other order of row A20).

import { describe, expect, it } from "vitest";
import { squidFile } from "./canned.ts";
import { SWEEP_B } from "./sweep-b.ts";
import { bag, entityDiff, hu, item, ok, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });
const DRAIN = E("world/energy.js#drain");
const DRAIN_OLD = "export function drain(creature, amount) {\n  creature.energy = Math.max(0, creature.energy - amount);\n}";
const DRAIN_PERCENT = "export function drain(creature, percent) {\n  creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);\n}";

function toWrite(b: ReturnType<typeof bag>): void {
  step(SWEEP_B, b, null);
  for (let i = 0; i < 8; i += 1) step(SWEEP_B, b, ok());
}

describe("sweep-b (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(SWEEP_B.id).toBe("sweep-b");
    expect(SWEEP_B.intent).toBe("a squid that shoots forward every three seconds and spends a tenth of its energy on each burst");
    expect(SWEEP_B.truth).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "entity:world/energy.js#drain",
      "entity:world/bounds.js#bounce",
      "entity:world/time.js#seconds",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
      "entity:world/movement.js#glide",
    ]);
  });

  it("issues the calls of 9.5 in order and writes the squid with `drain(squid, 0.1)`", () => {
    const b = bag();
    expect(step(SWEEP_B, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/energy.js", entity: "drain" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js", entity: "bounce" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/time.js", entity: "seconds" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js", entity: "step" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js", entity: "wander" } });
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js", entity: "glide" } });
    const w = step(SWEEP_B, b, ok());
    expect((w as { args: { content: string } }).args.content).toBe(squidFile("0.1"));
    expect(step(SWEEP_B, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("an E2 `repair` before the write makes the write carry `drain(squid, 10)`", () => {
    const b = bag();
    step(SWEEP_B, b, null);
    step(SWEEP_B, b, ok());
    step(SWEEP_B, b, ok());
    step(SWEEP_B, b, ok(), [hu(1, "repair", [item(DRAIN, entityDiff(DRAIN_OLD, DRAIN_PERCENT))])]);
    for (let i = 0; i < 5; i += 1) step(SWEEP_B, b, ok());
    const w = step(SWEEP_B, b, ok());
    expect((w as { args: { content: string } }).args.content).toBe(squidFile("10"));
  });

  it("an E2 `repair` after the write queues `0.1 -> 10` and acknowledges it (A20)", () => {
    const b = bag();
    toWrite(b);
    step(SWEEP_B, b, ok()); // write issued
    const next = step(SWEEP_B, b, ok(), [hu(1, "repair", [item(DRAIN, entityDiff(DRAIN_OLD, DRAIN_PERCENT))])]);
    expect(next).toMatchObject({
      tool: "replace",
      args: { path: "creatures/squid.js", old: "drain(squid, 0.1)", new: "drain(squid, 10)" },
    });
    const s = step(SWEEP_B, b, ok());
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "drain now takes percent; rewrote the burst to 10",
    });
  });

  it("a `repair` that shows no `percent` drain changes nothing", () => {
    const b = bag();
    step(SWEEP_B, b, null);
    const next = step(SWEEP_B, b, ok(), [hu(1, "repair", [item(DRAIN, entityDiff(DRAIN_OLD, "export function drain() {}"))])]);
    expect(next).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
  });
});
