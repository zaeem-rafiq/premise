// The shell context every view reads: the static settings of `/floor.json`, whether the
// visitor reads the CP7 forms (a visitor, and everyone in Replay), and `text()` with that
// flag folded in so no component builds a user-facing string of its own (5.1, AC7).

import { createContext } from "react";
import type { FloorJson } from "../../protocol/floor-json.ts";
import type { CopyVars } from "../../copy/fill.ts";
import { template, text } from "../../copy/strings.ts";
import { modelName } from "../../copy/names.ts";

export type Shell = {
  settings: FloorJson;
  /** CP7: true for a visitor and for every reader in Replay. */
  visitor: boolean;
  /** `text(id, vars)` with the visitor flag folded in. Every variable a copy id needs
   * is passed where it is called - the context fills none (`intent.queue`'s `{max}`
   * comes from the caller's `floor.pool.max_real_agents`, FR26). */
  t: (id: string, vars?: CopyVars) => string;
  /** `modelName` checked against `/floor.json`'s own table first (5.2). */
  model: (id: string) => string;
};

export function makeShell(settings: FloorJson, owner: boolean, replay: boolean): Shell {
  const visitor = !owner || replay;
  return {
    settings,
    visitor,
    t: (id, vars = {}) => {
      // 5.4/CP7: a reader kind can name its own copy id (`rail.empty.working.visitor`,
      // `rail.empty.working.replay`): the caller keeps the base id and this lookup picks
      // the variant the table holds. Replay wins over visitor - everyone in a recording
      // reads the recording's sentence. A caller may still pin `visitor: false`.
      const reader = replay ? "replay" : (vars.visitor ?? visitor) ? "visitor" : null;
      const variant = reader === null ? id : `${id}.${reader}`;
      return text(template(variant) === undefined ? id : variant, { visitor, ...vars });
    },
    model: (id) => settings.models[id] ?? modelName(id),
  };
}

export const ShellContext = createContext<Shell | null>(null);
