// The SHOULD features this build has (FJ1): the one place the page (`/floor.json`) and the engine
// read the same values. A slice turns its feature on when the lead merges it; a feature that fails
// its acceptance check at the freeze is switched off here (BP4).
//
// On since 2026-10-06, after each slice's acceptance on main and a live check on `test`: `held`
// (Slice 11), `race` (Slice 12) and `undo` (Slice 13). The green line, Clef and attempt repositories
// remain off pending their live checks: `green` is "none", the others are false. Outside agents
// over MCP (07-mcp) are built and off until the lead's live check on `test`. The minimal held form
// of HD1 — `land` and `decline` on a `held` submit — exists in every build.

import type { Features } from "../protocol/floor-json.ts";

export const FEATURES: Features = {
  held: true,
  race: true,
  undo: true,
  green: "full",
  clef: false,
  attempt_repos: true,
  mcp: true,
  text_merge: true,
};
