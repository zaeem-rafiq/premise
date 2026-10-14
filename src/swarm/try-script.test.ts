// The try conductor (09-try TY8): each row of TY8's table, fed with the events the row waits
// for. Expected actions are the table's cells; the events are those 7.11's rows name.

import { describe, expect, it } from "vitest";
import type { Conductor, ConductorAction } from "./conductor.ts";
import { tryConductor, tryScript } from "./try-script.ts";

const ATTEMPT: Record<string, string> = {
  "hero-s": "att-s",
  "hero-c": "att-c",
  "hero-h": "att-h",
  "hero-j": "att-j",
};

function act(c: Conductor): ConductorAction[] {
  const actions = c.takeActions();
  for (const a of actions) {
    if (a.type === "start") for (const p of a.patterns) c.bind(p, ATTEMPT[p] as string);
  }
  return actions;
}

const op = (path: string, pattern: string) => ({ type: "op.recorded", path, attempt_id: ATTEMPT[pattern] });
const accepted = (seq: number, pattern: string) => ({ type: "landing.accepted", seq, attempt_id: ATTEMPT[pattern] });
const landed = (seq: number) => ({ type: "landing.landed", seq });
const hs = (result: string, pattern: string) => ({ type: "headsup.sent", result, attempt_id: ATTEMPT[pattern] });

describe("TY8: the try conductor's rows", () => {
  const c = tryConductor();

  it("TY8 row 0: does nothing until the seed's `batch.pushed`", () => {
    expect(act(c)).toEqual([]);
    c.observe({ type: "pool.state" });
    expect(c.row).toBe(0);
    c.observe({ type: "batch.pushed" });
    expect(c.row).toBe(1);
  });

  it("TY8 row 1: starts J, C and H with C and H held; waits for both writes and J's landing", () => {
    expect(act(c)).toEqual([
      { type: "start", patterns: ["hero-j", "hero-c", "hero-h"], hold_before_submit: ["hero-c", "hero-h"] },
    ]);
    c.observe(op("creatures/crab.js", "hero-c"));
    c.observe(op("creatures/shrimp.js", "hero-h"));
    expect(c.row).toBe(1); // J has not landed yet
    c.observe(accepted(1, "hero-j"));
    c.observe(landed(1));
    expect(c.row).toBe(2);
  });

  it("TY8 row 2: starts S unheld; waits for a held card", () => {
    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }]);
    c.observe({ type: "card.opened", card: { card_id: "card-1", kind: "choice", attempt_ids: ["att-s"] } });
    expect(c.row).toBe(2);
    c.observe({ type: "card.opened", card: { card_id: "card-2", kind: "held", attempt_ids: ["att-s"] } });
    expect(c.row).toBe(3);
  });

  it("TY8 row 3: taps Land; waits for the repairs to C and H and S's landing", () => {
    expect(act(c)).toEqual([{ type: "tap", option: "land" }]);
    c.observe(hs("repair", "hero-c"));
    c.observe(accepted(2, "hero-s"));
    c.observe(landed(2));
    expect(c.row).toBe(3); // no repair to H yet
    c.observe(hs("confirm", "hero-h"));
    expect(c.row).toBe(3); // a confirm is not a repair
    c.observe(hs("repair", "hero-h"));
    expect(c.row).toBe(4);
  });

  it("TY8 row 4: releases C and H only (J was never held); ends on both landings", () => {
    expect(act(c)).toEqual([{ type: "release", patterns: ["hero-c", "hero-h"] }]);
    c.observe(accepted(3, "hero-c"));
    c.observe(landed(3));
    expect(c.done).toBe(false);
    c.observe(accepted(4, "hero-h"));
    c.observe(landed(4));
    expect(c.done).toBe(true);
    expect(act(c)).toEqual([]);
  });
});

describe("TY5: the try conductor only names the canned cast", () => {
  it("TY5: every started or released pattern is one of 10.5's hero casts, and no row needs a browser", () => {
    const named = tryScript().flatMap((row) =>
      row.actions.flatMap((a) => (a.type === "start" || a.type === "release" ? a.patterns : [])),
    );
    expect(new Set(named)).toEqual(new Set(["hero-s", "hero-c", "hero-h", "hero-j"]));
    const kinds = tryScript().flatMap((row) => row.actions.map((a) => a.type));
    expect(kinds).toEqual(["start", "start", "tap", "release"]);
  });
});
