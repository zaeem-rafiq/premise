// The floor-shell lane's wiring module for the registry seam (04-build-plan 3.2). The lane registers
// its views, sheets and keys here; it edits this file, never `../registry.ts`.
//
// What the shell registers: `view.swarm` (the Swarm view of 3.15), the sheet entries it owns
// (`sheet.about`, `sheet.owner`, `sheet.kill`) and one `key.<name>` entry per keybinding of
// `keys/keys.ts`. The pool area and the rail are regions the app imports directly, not registry
// entries.
//
// A view or sheet's `value` is the entry's own name, a tag `app.tsx` binds to the component.
// This module cannot import the `.tsx` files themselves: `test/arch/seams.test.ts` imports the
// seam, so every wiring module is also compiled in the Node test program, which has no JSX.
// A `value` that is a component function is called as it is; a lane that can register one may.

import type { RegistryTable } from "../registry.ts";

const SHELL_VIEWS = ["view.swarm"] as const;
const SHELL_SHEETS = ["sheet.about", "sheet.owner", "sheet.kill"] as const;
const SHELL_KEYS = [
  "focus-intent",
  "view-floor",
  "view-swarm",
  "view-about",
  "view-compare",
  "needs-you",
  "tab-landed",
  "git-drawer",
  "pause-frames",
  "kill",
  "replay-default",
  "theme",
  "type-size",
  "shortcuts",
  "escape",
] as const;

export function wire(table: RegistryTable): void {
  for (const name of SHELL_VIEWS) {
    table.entries.set(name, { kind: "view", name, value: name });
  }
  for (const name of SHELL_SHEETS) {
    table.entries.set(name, { kind: "sheet", name, value: name });
  }
  for (const key of SHELL_KEYS) {
    table.entries.set(`key.${key}`, { kind: "key", name: `key.${key}`, value: key });
  }
}
