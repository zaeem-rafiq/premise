// The floor-rail lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

const RAIL_SHEETS = ["sheet.card"] as const;

export function wire(table: RegistryTable): void {
  // `sheet.card` is the no-frames card sheet of 03-floor 2.4/3.13/3.14 (held, choice, race); the
  // lane binds it in `rail.views.tsx` and `app.tsx` draws it — the one place it renders.
  for (const name of RAIL_SHEETS) {
    table.entries.set(name, { kind: "sheet", name, value: name });
  }
}
