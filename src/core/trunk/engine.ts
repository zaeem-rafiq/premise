// The engine seam (04-build-plan 3.2): a table type and no logic. An engine entry is a tool, a tick
// step, an owner action or an effect kind; the lanes register theirs in the wiring modules this seam
// calls, so a lane edits its wiring module and never the seam.

import { wire as wireEngine } from "./wiring/engine.ts";
import { wire as wireGit } from "./wiring/git.ts";

/** One registered engine entry. The engine's own argument and context types are the lanes' work:
 * they refine the signature when they register. */
export type EntryHandler = (input: unknown, ctx: unknown) => unknown;

export type EngineTable = {
  /** Engine entries by name: the tools, the tick steps and the owner actions. */
  entries: Map<string, EntryHandler>;
  /** The effect kinds the engine may emit for `src/worker/trunk/effects.ts` to run after the transaction. */
  effects: Set<string>;
};

export function engineTable(): EngineTable {
  const table: EngineTable = { entries: new Map(), effects: new Set() };
  wireEngine(table);
  wireGit(table);
  return table;
}
