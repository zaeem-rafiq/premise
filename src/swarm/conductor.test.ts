// The conductor (02-tidepool.md 7.11): each row of the two tables — landing order 1 and
// landing order 2 — on seed `tidepool` (paced by the held card) and on seed `tidepool-auto`
// (paced by holding `hero-s`), fed with the events the row waits for.

import { describe, expect, it } from "vitest";
import { createConductor, heroConductor, type Conductor, type ConductorAction } from "./conductor.ts";

const ATTEMPT: Record<string, string> = {
  "hero-s": "att-s",
  "hero-c": "att-c",
  "hero-h": "att-h",
  "hero-j": "att-j",
};

/** Feed one event; `pattern` resolves the attempt the event belongs to. */
function ev(c: Conductor, event: Record<string, unknown>, pattern?: string): void {
  if (
    pattern !== undefined &&
    event.attempt_id === undefined &&
    event.card_id === undefined &&
    event.seq === undefined
  ) {
    event.attempt_id = ATTEMPT[pattern];
  }
  c.observe(event);
}

/** Bind every started pattern to its attempt id (what a driver does on `attempt.opened`). */
function bindAll(c: Conductor, actions: ConductorAction[]): void {
  for (const a of actions) {
    if (a.type !== "start") continue;
    for (const p of a.patterns) c.bind(p, ATTEMPT[p] as string);
  }
}

/** Take the pending actions and bind any starts. */
function act(c: Conductor): ConductorAction[] {
  const actions = c.takeActions();
  bindAll(c, actions);
  return actions;
}

const op = (path: string, pattern: string) => ({ type: "op.recorded", path, attempt_id: ATTEMPT[pattern] });
const landed = (pattern: string) => ({ type: "landing.landed", seq: 0, attempt_id: ATTEMPT[pattern] });
const hs = (result: string, pattern: string) => ({ type: "headsup.sent", result, attempt_id: ATTEMPT[pattern] });

describe("conductor, landing order 1 on seed `tidepool` (7.11)", () => {
  const c = heroConductor(1, "tidepool");

  it("row 1 starts the three creatures held and waits for the two writes", () => {
    expect(act(c)).toEqual([
      { type: "start", patterns: ["hero-j", "hero-c", "hero-h"], hold_before_submit: ["hero-j", "hero-c", "hero-h"] },
    ]);
    expect(c.row).toBe(0);
    ev(c, op("creatures/crab.js", "hero-c"));
    expect(c.row).toBe(0); // still waiting on the shrimp write
    ev(c, op("creatures/shrimp.js", "hero-h"));
    expect(c.row).toBe(1);
  });

  it("row 2 starts `hero-s` unheld and waits for its held card", () => {
    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }]);
    ev(c, { type: "card.opened", card: { card_id: "card-1", kind: "held", attempt_ids: ["att-s"] } });
    expect(c.row).toBe(2);
  });

  it("row 3 opens the Compare view and waits for both `stats`", () => {
    expect(act(c)).toEqual([{ type: "open_compare" }]);
    ev(c, { type: "stats", frame: "main" });
    expect(c.row).toBe(2);
    ev(c, { type: "stats", frame: "plain" });
    expect(c.row).toBe(3);
  });

  it("row 4 taps `land` and waits for the two E2s and S's landing", () => {
    expect(act(c)).toEqual([{ type: "tap", option: "land" }]);
    ev(c, hs("repair", "hero-c"));
    ev(c, hs("repair", "hero-h"));
    expect(c.row).toBe(3);
    ev(c, { type: "landing.accepted", seq: 3, attempt_id: "att-s" });
    ev(c, { type: "landing.landed", seq: 3 });
    expect(c.row).toBe(4);
  });

  it("row 5 releases the creatures and waits for three landings and `plain.updated`", () => {
    expect(act(c)).toEqual([{ type: "release", patterns: ["hero-j", "hero-c", "hero-h"] }]);
    ev(c, { type: "landing.accepted", seq: 4, attempt_id: "att-c" });
    ev(c, { type: "landing.landed", seq: 4 });
    ev(c, { type: "landing.accepted", seq: 5, attempt_id: "att-h" });
    ev(c, { type: "landing.landed", seq: 5 });
    ev(c, { type: "landing.accepted", seq: 6, attempt_id: "att-j" });
    ev(c, { type: "landing.landed", seq: 6 });
    expect(c.row).toBe(4);
    ev(c, { type: "plain.updated", through_seq: 4 });
    expect(c.row).toBe(5);
  });

  it("row 6 probes `selftest` and finishes when both frames report", () => {
    expect(act(c)).toEqual([{ type: "probe", selftest: true, frames: ["main", "plain"] }]);
    ev(c, { type: "stats", frame: "main", selftest: { ok: true } });
    ev(c, { type: "stats", frame: "plain", selftest: { ok: true } });
    expect(c.done).toBe(true);
  });
});

describe("conductor, landing order 2 on seed `tidepool` (7.11)", () => {
  const c = heroConductor(2, "tidepool");

  it("row 1 starts `hero-s` and waits for its held submit", () => {
    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }]);
    ev(c, { type: "submit.result", status: "held", attempt_id: "att-s" });
    expect(c.row).toBe(1);
  });

  it("row 2 starts the creatures and waits for the landings, the QR1, the stale card and the new held card", () => {
    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-c", "hero-h", "hero-j"], hold_before_submit: [] }]);
    ev(c, { type: "landing.accepted", seq: 2, attempt_id: "att-c" });
    ev(c, { type: "landing.landed", seq: 2 });
    ev(c, { type: "landing.accepted", seq: 3, attempt_id: "att-h" });
    ev(c, { type: "landing.landed", seq: 3 });
    ev(c, { type: "landing.accepted", seq: 4, attempt_id: "att-j" });
    ev(c, { type: "landing.landed", seq: 4 });
    ev(c, hs("repair", "hero-s"));
    expect(c.row).toBe(1);
    ev(c, { type: "card.opened", card: { card_id: "card-1", kind: "held", attempt_ids: ["att-s"] } });
    ev(c, { type: "card.closed", card_id: "card-1", action: "stale" });
    expect(c.row).toBe(2);
  });

  it("row 3 taps `land` and finishes on S's landing", () => {
    expect(act(c)).toEqual([{ type: "tap", option: "land" }]);
    ev(c, { type: "landing.accepted", seq: 5, attempt_id: "att-s" });
    ev(c, { type: "landing.landed", seq: 5 });
    expect(c.done).toBe(true);
  });
});

describe("conductor, landing order 1 on seed `tidepool-auto` (7.11 last row)", () => {
  const c = heroConductor(1, "tidepool-auto");

  it("paces by holding `hero-s`: no card is tapped, `hero-s` is released instead", () => {
    expect(act(c)).toEqual([
      { type: "start", patterns: ["hero-j", "hero-c", "hero-h"], hold_before_submit: ["hero-j", "hero-c", "hero-h"] },
    ]);
    ev(c, op("creatures/crab.js", "hero-c"));
    ev(c, op("creatures/shrimp.js", "hero-h"));
    expect(c.row).toBe(1);

    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-s"], hold_before_submit: ["hero-s"] }]);
    ev(c, op("world/energy.js", "hero-s"));
    expect(c.row).toBe(2);

    expect(act(c)).toEqual([{ type: "open_compare" }]);
    ev(c, { type: "stats", frame: "main" });
    ev(c, { type: "stats", frame: "plain" });
    expect(c.row).toBe(3);

    expect(act(c)).toEqual([{ type: "release", patterns: ["hero-s"] }]);
    ev(c, hs("repair", "hero-c"));
    ev(c, hs("repair", "hero-h"));
    ev(c, { type: "landing.accepted", seq: 3, attempt_id: "att-s" });
    ev(c, { type: "landing.landed", seq: 3 });
    expect(c.row).toBe(4);

    expect(act(c)).toEqual([{ type: "release", patterns: ["hero-j", "hero-c", "hero-h"] }]);
    ev(c, { type: "landing.accepted", seq: 4, attempt_id: "att-c" });
    ev(c, { type: "landing.landed", seq: 4 });
    ev(c, { type: "landing.accepted", seq: 5, attempt_id: "att-h" });
    ev(c, { type: "landing.landed", seq: 5 });
    ev(c, { type: "landing.accepted", seq: 6, attempt_id: "att-j" });
    ev(c, { type: "landing.landed", seq: 6 });
    ev(c, { type: "plain.updated", through_seq: 4 });
    expect(c.row).toBe(5);

    expect(act(c)).toEqual([{ type: "probe", selftest: true, frames: ["main", "plain"] }]);
    ev(c, { type: "stats", frame: "main", selftest: {} });
    ev(c, { type: "stats", frame: "plain", selftest: {} });
    expect(c.done).toBe(true);
  });
});

describe("conductor, landing order 2 on seed `tidepool-auto` (7.11 last row)", () => {
  const c = heroConductor(2, "tidepool-auto");

  it("starts `hero-s` held, lands the creatures under its QR1, then releases it", () => {
    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-s"], hold_before_submit: ["hero-s"] }]);
    ev(c, op("world/energy.js", "hero-s"));
    expect(c.row).toBe(1);

    expect(act(c)).toEqual([{ type: "start", patterns: ["hero-c", "hero-h", "hero-j"], hold_before_submit: [] }]);
    ev(c, { type: "landing.accepted", seq: 2, attempt_id: "att-c" });
    ev(c, { type: "landing.landed", seq: 2 });
    ev(c, { type: "landing.accepted", seq: 3, attempt_id: "att-h" });
    ev(c, { type: "landing.landed", seq: 3 });
    ev(c, { type: "landing.accepted", seq: 4, attempt_id: "att-j" });
    ev(c, { type: "landing.landed", seq: 4 });
    ev(c, hs("repair", "hero-s"));
    expect(c.row).toBe(2);

    expect(act(c)).toEqual([{ type: "release", patterns: ["hero-s"] }]);
    ev(c, { type: "landing.accepted", seq: 5, attempt_id: "att-s" });
    ev(c, { type: "landing.landed", seq: 5 });
    expect(c.done).toBe(true);
  });
});

describe("createConductor", () => {
  it("counted waits need their count; a `*` match needs the field present", () => {
    const c = createConductor([
      {
        actions: [],
        until: [
          { event: "tick", count: 2 },
          { event: "note", match: { tag: "*" } },
        ],
      },
      { actions: [{ type: "open_compare" }], until: [] },
    ]);
    c.observe({ type: "tick" });
    c.observe({ type: "note" });
    expect(c.row).toBe(0);
    c.observe({ type: "tick" });
    c.observe({ type: "note", tag: "x" });
    // row 0 done; row 1's empty `until` completes at once — the conductor is done and the
    // open_compare action it queued is the one the driver performs.
    expect(c.takeActions()).toEqual([{ type: "open_compare" }]);
    expect(c.done).toBe(true);
  });
});
