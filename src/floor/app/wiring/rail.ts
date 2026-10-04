// The floor-rail lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

const RAIL_SHEETS = ["sheet.card"] as const;

export function wire(table: RegistryTable): void {
  // `sheet.card` is the no-frames card sheet of 03-floor 2.4/3.13/3.14 (held, choice, race); the
  // lane binds it in `rail.views.tsx`. The rail renders it locally today — `app.tsx` has no
  // `sheet.kind === "card"` branch yet — and the registration lets the shell resolve the same
  // component when that branch lands.
  for (const name of RAIL_SHEETS) {
    table.entries.set(name, { kind: "sheet", name, value: name });
  }
}
