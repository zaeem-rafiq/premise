// The try conductor's script (09-try TY8): the rows of 7.11's conductor that a visitor's try
// pool plays on the server. The jellyfish starts unheld and lands by itself; the crab and the
// shrimp hold their submits until the shared rule has landed and their heads-ups went out. No
// row opens the Compare view or probes a frame: the server has no browser.

import { createConductor, type Conductor, type ConductorRow, type WaitCond } from "./conductor.ts";

const landed = (pattern: string): WaitCond => ({ event: "landing.landed", match: { pattern } });

/** The rows of TY8's table, row 0 first. */
export function tryScript(): ConductorRow[] {
  return [
    // Row 0: the seed is on the remote (PL1) before any attempt starts.
    { actions: [], until: [{ event: "batch.pushed" }] },
    {
      actions: [{ type: "start", patterns: ["hero-j", "hero-c", "hero-h"], hold_before_submit: ["hero-c", "hero-h"] }],
      until: [
        { event: "op.recorded", match: { path: "creatures/crab.js" } },
        { event: "op.recorded", match: { path: "creatures/shrimp.js" } },
        landed("hero-j"),
      ],
    },
    {
      actions: [{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }],
      until: [{ event: "card.opened", match: { kind: "held" } }],
    },
    {
      actions: [{ type: "tap", option: "land" }],
      until: [
        { event: "headsup.sent", match: { result: "repair", pattern: "hero-c" } },
        { event: "headsup.sent", match: { result: "repair", pattern: "hero-h" } },
        landed("hero-s"),
      ],
    },
    {
      actions: [{ type: "release", patterns: ["hero-c", "hero-h"] }],
      until: [landed("hero-c"), landed("hero-h")],
    },
  ];
}

export function tryConductor(): Conductor {
  return createConductor(tryScript());
}
