// The floor-rail lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.

import type { RegistryTable } from "../registry.ts";

const RAIL_SHEETS = ["sheet.card", "sheet.held", "sheet.race"] as const;

export function wire(table: RegistryTable): void {
  // `sheet.card` is the seam `app.tsx` draws for every card kind; its binding in
  // `rail.views.tsx` dispatches on the card's kind to the held sheet (3.13), the race sheet
  // (3.14) or the no-frames card sheet of `card-sheet.tsx` (choice, and any kind the dispatch
  // does not know). `sheet.held` and `sheet.race` are the same components bound directly, for a
  // host that opens a card by its kind.
  for (const name of RAIL_SHEETS) {
    table.entries.set(name, { kind: "sheet", name, value: name });
  }
}
