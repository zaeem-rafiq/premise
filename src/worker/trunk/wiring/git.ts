// The git lane's wiring module for the effects seam (04-build-plan 3.2). The lane registers its
// effect handlers (the push, plain-merge, preview and rebuild runners of plan 3.1) here; it edits
// this file, never `../effects.ts`.

import type { EffectTable } from "../effects.ts";

export function wire(_table: EffectTable): void {
  // Empty while the git lane's slice is not built (Slice 0). The lane registers its handlers here.
}
