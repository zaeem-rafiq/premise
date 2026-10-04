// The git lane's wiring module for the engine seam (04-build-plan 3.2). The lane registers its
// engine entries (the outbox, register and restart work of plan 3.1) here; it edits this file,
// never `../engine.ts`.

import type { EngineTable } from "../engine.ts";

export function wire(_table: EngineTable): void {
  // Empty while the git lane's slice is not built (Slice 0). The lane registers its entries here.
}
