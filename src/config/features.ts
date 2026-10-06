// The SHOULD features this build has (FJ1): the one place the page (`/floor.json`) and the engine
// read the same values. A slice turns its feature on when the lead merges it; a feature that fails
// its acceptance check at the freeze is switched off here (BP4).
//
// On since 2026-10-06, after each slice's acceptance on main and a live check on `test`: `held`
// (Slice 11), `race` (Slice 12) and `undo` (Slice 13). The green line, Clef and attempt repositories
// are not built: `green` is "none", the others are off. The minimal held form of HD1 — `land` and
// `decline` on a `held` submit — is not a feature: it exists in every build.

import type { Features } from "../protocol/floor-json.ts";

export const FEATURES: Features = {
  held: true,
  race: true,
  undo: true,
  green: "none",
  clef: false,
  attempt_repos: false,
};
