// The SHOULD features this build has (FJ1): the one place the page (`/floor.json`) and the engine
// read the same values. A slice turns its feature on when the lead merges it; a feature that fails
// its acceptance check at the freeze is switched off here (BP4).
//
// Slice 0b: nothing of section 10 to 12 is built, so every key is off and `green` is "none". The
// minimal held form of HD1 — `land` and `decline` on a `held` submit — is not a feature: it exists
// in every build.

import type { Features } from "../protocol/floor-json.ts";

export const FEATURES: Features = {
  held: false,
  race: false,
  undo: false,
  green: "none",
  clef: false,
  attempt_repos: false,
};
