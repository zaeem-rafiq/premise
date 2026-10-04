// The floor-pool lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

export function wire(_table: RegistryTable): void {
  // Slice 1 registers nothing. The registry's entries are views, sheets and keys, and this slice
  // gives the lane none of those: the pool area (`../components/pool-frame/`, exported as PoolArea
  // from `pool-area.tsx`) is a region component the Floor view renders — it is the live pool frame
  // of 03-floor 3.5 — not a body view. The lane's own entries land with their slices: the Compare
  // view (a body view, 3.6/CO24), the sheets `why`, `who-relies`, `git-drawer` and `undo-sheet`,
  // and the keys they carry (C when Compare registers). The shell mounts the pool area by
  // importing it directly:
  //
  //   import { PoolArea } from "../components/pool-frame/pool-area.tsx";
  //   import type { PoolAreaProps } from "../components/pool-frame/pool-area.tsx";
  //
  // props `{ pool, state, mode, paused?, onPausedChange?, onCompare?, onFrameStats?, onTapped?,
  // highlight?, seed?, name? }` — the shell's slice of `ViewState` plus the reduced `FloorState`
  // at the shown position.
  //
  // Note the Slice-0 check `registry().entries.size === 0` of test/arch/seams.test.ts also pins
  // this table empty until the first lane registers; registering before then needs the lead to
  // update that check.
}
