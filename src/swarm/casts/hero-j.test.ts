// `hero-j` (02-tidepool.md 7.3, 10.5): the canned row verbatim, and J takes the SW6 defaults —
// nothing in 7.3 gives it a repair operation, so a dropped op stops it `withdrawn`.

import { describe, expect, it } from "vitest";
import { JELLYFISH_FILE } from "./canned.ts";
import { HERO_J } from "./hero-j.ts";
import { bag, entityDiff, err, hu, item, ok, step } from "./testkit.ts";

const E = (key: string) => ({ kind: "entity" as const, key });

describe("hero-j (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(HERO_J.id).toBe("hero-j");
    expect(HERO_J.intent).toBe("a jellyfish that drifts up and down");
    expect(HERO_J.truth).toEqual(["entity:world/bounds.js#SURFACE_Y", "entity:world/bounds.js#FLOOR_Y"]);
  });

  it("issues the calls of 7.3 in order and submits with its intent as summary", () => {
    const b = bag();
    expect(step(HERO_J, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(HERO_J, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(HERO_J, b, ok())).toMatchObject({
      tool: "read",
      args: { path: "world/bounds.js", entity: "SURFACE_Y" },
    });
    expect(step(HERO_J, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } });
    expect(step(HERO_J, b, ok())).toMatchObject({
      tool: "write",
      args: { path: "creatures/jellyfish.js", content: JELLYFISH_FILE },
    });
    expect(step(HERO_J, b, ok())).toMatchObject({
      tool: "submit",
      args: { summary: "a jellyfish that drifts up and down" },
    });
  });

  it("waits at a held submit until released (SW8/SWR3)", () => {
    const b = bag();
    for (const r of [null, ok(), ok(), ok(), ok(), ok()]) step(HERO_J, b, r, [], { hold: true });
    expect(step(HERO_J, b, null, [], { hold: true }).kind).toBe("wait");
    expect(step(HERO_J, b, null, [], { hold: true, released: true })).toMatchObject({ tool: "submit" });
  });

  it("retries a call refused `heads_up_first` (TA3) after answering the heads-up", () => {
    const b = bag();
    step(HERO_J, b, null);
    // TA3: the refusal did not record the call — the same `list` is issued again.
    expect(step(HERO_J, b, err("heads_up_first"), [hu(1, "info", [])])).toMatchObject({
      tool: "list",
      args: { path: "creatures/" },
    });
  });

  it("stops `withdrawn` when a heads-up drops an op the cast cannot re-derive (SW6)", () => {
    const b = bag();
    for (const r of [null, ok(), ok(), ok(), ok(), ok()]) step(HERO_J, b, r);
    const out = step(HERO_J, b, null, [
      hu(
        1,
        "repair",
        [item(E("world/bounds.js#SURFACE_Y"), entityDiff("x", "y"))],
        [{ op_seq: 1, path: "creatures/jellyfish.js", rule: "OP2" }],
      ),
    ]);
    expect(out).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });
});
