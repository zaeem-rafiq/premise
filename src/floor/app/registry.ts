// The registry seam (04-build-plan 3.2): the table the Floor's views, sheets and keys register in.
// The contract, for the lanes that wire it:
// - A view is what the body shows (Floor, Compare, Swarm, Replay); a sheet opens over it; a key is
//   a keybinding. A lane adds an entry in its own `wiring/*.ts` module, never here.
// - An entry's `value` is its own name, a tag. The wiring module cannot import `.tsx`: this seam is
//   loaded by the Node test program, which has no JSX.
// - Each lane binds its tags to components in `wiring/<lane>.views.tsx`, which exports `views`, a
//   record from tag to component. `bindings.tsx` merges the three records; `app.tsx` resolves a
//   tag only through it.

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
