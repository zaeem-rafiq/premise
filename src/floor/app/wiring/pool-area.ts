// The floor-pool lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

export function wire(_table: RegistryTable): void {
  // Empty while the floor-pool lane's slice is not built (Slice 0). The lane registers here.
}
