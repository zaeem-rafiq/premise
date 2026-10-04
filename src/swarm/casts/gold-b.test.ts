// `gold-b` (02-tidepool.md 8.2, 10.5): the canned row verbatim — an `info` heads-up about the
// repaint landing first needs no acknowledgement and changes nothing (8.4).

import { describe, expect, it } from "vitest";
import { SEAHORSE_FILE } from "./canned.ts";
import { GOLD_B } from "./gold-b.ts";
import { bag, entityDiff, hu, item, ok, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });

describe("gold-b (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(GOLD_B.id).toBe("gold-b");
    expect(GOLD_B.intent).toBe("a seahorse that bobs up and down");
    expect(GOLD_B.truth).toEqual(["entity:world/bounds.js#SURFACE_Y", "entity:world/bounds.js#FLOOR_Y"]);
  });

  it("issues the calls of 8.2 in order and writes the canned seahorse verbatim", () => {
    const b = bag();
    expect(step(GOLD_B, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(GOLD_B, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(GOLD_B, b, ok())).toMatchObject({ tool: "read", args: { path: "creatures/fish.js" } });
    expect(step(GOLD_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js" } });
    expect(step(GOLD_B, b, ok())).toMatchObject({
      tool: "write",
      args: { path: "creatures/seahorse.js", content: SEAHORSE_FILE },
    });
    expect(step(GOLD_B, b, ok())).toMatchObject({
      tool: "submit",
      args: { summary: "a seahorse that bobs up and down" },
    });
  });

  it("an `info` item about the repaint needs no acknowledgement (8.4)", () => {
    const b = bag();
    step(GOLD_B, b, null);
    step(GOLD_B, b, ok(), [
      hu(1, "info", [item(E("creatures/fish.js#BODY"), entityDiff('"pink"', '"gold"'), "holds")]),
    ]);
    for (const r of [ok(), ok(), ok(), ok()]) step(GOLD_B, b, r);
    const s = step(GOLD_B, b, ok());
    expect((s as { args: { acknowledge?: number[] } }).args.acknowledge).toBeUndefined();
  });
});
