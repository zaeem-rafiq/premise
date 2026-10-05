// `sweep-a` (02-tidepool.md 9.5, 10.5): the percent sweep verbatim — the `drain` body and the
// `liveOneTick` line of world/energy.js, every found `drain(<name>, <n>)` -> `<n> x 100` — the
// QT1+QR1 `repair` of beat 5 that rewrites the gained module with no read (one call text is
// replaced once even when both items name it), and SW7's `withdrawn` at a second `repair`.

import { describe, expect, it } from "vitest";
import { SWEEP_A } from "./sweep-a.ts";
import { bag, entityDiff, hu, item, ok, queryDiff, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });
const Q = (key: string) => ({ kind: "query" as const, key });

const DRAIN_OLD = `// Take energy away. \`amount\` is in the same unit as ENERGY_MAX.
export function drain(creature, amount) {
  creature.energy = Math.max(0, creature.energy - amount);
}`;
const DRAIN_NEW = `// Take energy away. \`percent\` is a share of a full tank in percent: 5 takes five percent of ENERGY_MAX.
export function drain(creature, percent) {
  creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);
}`;
const SQUID_UPDATE = `export function update(squid) {
  drain(squid, 0.1);
  step(squid);
}`;

describe("sweep-a (02-tidepool.md 10.5)", () => {
  it("carries the intent, summary and truth list of the table", () => {
    expect(SWEEP_A.id).toBe("sweep-a");
    expect(SWEEP_A.intent).toBe(
      "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy",
    );
    expect(SWEEP_A.truth).toEqual([
      "query:text:creatures/:drain(",
      "query:refs:world/energy.js#drain",
      "entity:world/energy.js#ENERGY_MAX",
      "entity:world/energy.js#LIVING_COST",
    ]);
  });

  it("runs the row of 9.5: reads, the search, the two energy.js replaces, the found calls", () => {
    const b = bag();
    expect(step(SWEEP_A, b, null)).toMatchObject({ kind: "tool", tool: "read", args: { path: "GUIDE.md" } });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "read",
      args: { path: "world/energy.js", entity: "ENERGY_MAX" },
    });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "read",
      args: { path: "world/energy.js", entity: "LIVING_COST" },
    });
    expect(step(SWEEP_A, b, ok())).toMatchObject({ tool: "read", args: { path: "world/energy.js", entity: "drain" } });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "read",
      args: { path: "world/energy.js", entity: "liveOneTick" },
    });
    expect(step(SWEEP_A, b, ok())).toMatchObject({ tool: "search", args: { query: "drain(", path: "creatures/" } });
    const r1 = step(SWEEP_A, b, ok({ lines: [{ path: "creatures/fish.js", text: "  drain(fish, 0.05);" }] }));
    expect(r1).toMatchObject({ tool: "replace", args: { path: "world/energy.js", old: DRAIN_OLD, new: DRAIN_NEW } });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "replace",
      args: {
        path: "world/energy.js",
        old: "  drain(creature, LIVING_COST);",
        new: "  drain(creature, (LIVING_COST / ENERGY_MAX) * 100);",
      },
    });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "replace",
      args: { path: "creatures/fish.js", old: "drain(fish, 0.05)", new: "drain(fish, 5)" },
    });
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "submit",
      args: { summary: "Write energy costs in percent" },
    });
  });

  it("the QT1+QR1 `repair` of beat 5 rewrites the gained module once, with no read", () => {
    const b = bag();
    for (const r of [null, ok(), ok(), ok(), ok(), ok(), ok({ lines: [] })]) step(SWEEP_A, b, r);
    const next = step(SWEEP_A, b, ok(), [
      hu(1, "repair", [
        item(Q("text:creatures/:drain("), queryDiff([{ key: "creatures/squid.js#update", source: SQUID_UPDATE }])),
        item(Q("refs:world/energy.js#drain"), queryDiff([{ key: "creatures/squid.js#update", source: SQUID_UPDATE }])),
      ]),
    ]);
    expect(next).toMatchObject({
      tool: "replace",
      args: { path: "creatures/squid.js", old: "drain(squid, 0.1)", new: "drain(squid, 10)" },
    });
    // one call text, one replace — the second item of the heads-up does not queue a duplicate;
    // the script's own pending `liveOneTick` edit still runs ahead of the submit.
    expect(step(SWEEP_A, b, ok())).toMatchObject({
      tool: "replace",
      args: {
        path: "world/energy.js",
        old: "  drain(creature, LIVING_COST);",
        new: "  drain(creature, (LIVING_COST / ENERGY_MAX) * 100);",
      },
    });
    const s = step(SWEEP_A, b, ok());
    expect(s).toMatchObject({ kind: "tool", tool: "submit" });
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "a new creature calls drain; rewrote its number to percent",
    });
    expect(b.calls.filter((c) => c.tool === "read").length).toBe(5); // no extra read for the repair
  });

  it("a second `repair` stops `withdrawn` (SW7)", () => {
    const b = bag();
    step(SWEEP_A, b, null);
    step(SWEEP_A, b, ok(), [hu(1, "repair", [item(E("world/energy.js#drain"), entityDiff("a", "b"))])]);
    const out = step(SWEEP_A, b, ok(), [hu(2, "repair", [item(E("world/energy.js#drain"), entityDiff("b", "c"))])]);
    expect(out).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });
});
