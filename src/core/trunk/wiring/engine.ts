// The engine lane's wiring module for the engine seam (04-build-plan 3.2). The lane registers its
// engine entries here; it edits this file, never `../engine.ts`.

import type { EngineTable } from "../engine.ts";

export function wire(_table: EngineTable): void {
  // Empty while the engine lane's slice is not built (Slice 0). The lane registers its entries here.
}
