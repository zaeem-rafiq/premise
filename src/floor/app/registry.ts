// The registry seam (04-build-plan 3.2): the table the Floor's views, sheets and keys register in.
// A view is what the body shows (Floor, Compare, Swarm, Replay); a sheet opens over it (a card, a Why
// card, About); a key is a keybinding. floor-shell wires `wiring/shell.ts`, floor-rail
// `wiring/rail.ts`, floor-pool `wiring/pool-area.ts`.

import { wire as wireShell } from "./wiring/shell.ts";
import { wire as wireRail } from "./wiring/rail.ts";
import { wire as wirePoolArea } from "./wiring/pool-area.ts";

/** One registered entry. What a view, a sheet or a keybinding carries is the lanes' work. */
export type RegistryEntry = { kind: "view" | "sheet" | "key"; name: string; value: unknown };

export type RegistryTable = { entries: Map<string, RegistryEntry> };

export function registry(): RegistryTable {
  const table: RegistryTable = { entries: new Map() };
  wireShell(table);
  wireRail(table);
  wirePoolArea(table);
  return table;
}
