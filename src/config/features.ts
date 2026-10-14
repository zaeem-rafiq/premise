// The SHOULD features this build has (FJ1): the one place the page (`/floor.json`) and the engine
// read the same values. A slice turns its feature on when the lead merges it; a feature that fails
// its acceptance check at the freeze is switched off here (BP4).
//
// On, each after its acceptance on main and a live check on `test`: `held`, `race` and `undo`
// (2026-10-06); the green line on the isolate runtime with the pre-landing self-test, attempt
// repositories, outside agents over MCP and the three-way text merge (2026-10-10 to 2026-10-11);
// Clef triage after its calibration and Try it (2026-10-14). The minimal held form of HD1 — `land`
// and `decline` on a `held` submit — exists in every build.

import type { Features } from "../protocol/floor-json.ts";

export const FEATURES: Features = {
  held: true,
  race: true,
  undo: true,
  green: "full",
  clef: true,
  attempt_repos: true,
  mcp: true,
  text_merge: true,
  // 09-try: off on the branch that builds it; the lead switches it on after a live check.
  try: true,
};
