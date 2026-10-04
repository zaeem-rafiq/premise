// The trunk lane's wiring module for the effects seam (04-build-plan 3.2). The lane registers its
// effect handlers here; it edits this file, never `../effects.ts`.

import type { EffectTable } from "../effects.ts";

export function wire(_table: EffectTable): void {
  // Empty while the trunk lane's slice is not built (Slice 0). The lane registers its handlers here.
}
