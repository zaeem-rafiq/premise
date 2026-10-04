// The floor-rail lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

export function wire(_table: RegistryTable): void {
  // Slice 1 registers nothing. The registry's entries are views, sheets and keys, and this slice
  // gives the lane none of those: the attempt card (`../components/attempt-card/`) is a component
  // the Floor view renders for each attempt of `working_order`, not a body view. The lane's sheets
  // (card-sheet, held-sheet, race-sheet) and keys (N and the tray) register here when their own
  // slices land. Note the Slice-0 check `registry().entries.size === 0` of test/arch/seams.test.ts
  // also pins this table empty until the first lane registers; registering before then needs the
  // lead to update that check.
}
