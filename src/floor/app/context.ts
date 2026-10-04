// The shell context every view reads: the static settings of `/floor.json`, whether the
// visitor reads the CP7 forms (a visitor, and everyone in Replay), and `text()` with that
// flag folded in so no component builds a user-facing string of its own (5.1, AC7).

import { createContext } from "react";
import type { FloorJson } from "../../protocol/floor-json.ts";
import type { CopyVars } from "../../copy/fill.ts";
import { text } from "../../copy/strings.ts";
import { modelName } from "../../copy/names.ts";

export type Shell = {
  settings: FloorJson;
  /** CP7: true for a visitor and for every reader in Replay. */
  visitor: boolean;
  /** `text(id, vars)` with the visitor flag folded in. */
  t: (id: string, vars?: CopyVars) => string;
  /** `modelName` checked against `/floor.json`'s own table first (5.2). */
  model: (id: string) => string;
};

export function makeShell(
  settings: FloorJson,
  owner: boolean,
  replay: boolean,
  /** The pool's live agent limit, read lazily. A caller that names a copy id but leaves
   * `{max}` unfilled (the rail's `intent.queue`, FR26) means this one - every other `{max}`
   * is passed where it is called. */
  poolMax?: () => number,
): Shell {
  const visitor = !owner || replay;
  return {
    settings,
    visitor,
    t: (id, vars = {}) =>
      text(id, {
        visitor,
        ...(vars.max === undefined && poolMax !== undefined ? { max: poolMax() } : {}),
        ...vars,
      }),
    model: (id) => settings.models[id] ?? modelName(id),
  };
}

export const ShellContext = createContext<Shell | null>(null);
