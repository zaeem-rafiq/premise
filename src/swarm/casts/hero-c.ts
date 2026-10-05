// `hero-c` — attempt C of 02-tidepool.md 7.3: `list creatures/`; `read GUIDE.md`; `read` the
// entities `energy#ENERGY_MAX`, `bounds#FLOOR_Y`, `bounds#bounce`, `movement#step`; `write`
// creatures/crab.js (the canned file of 7.3); `submit`.
//
// The crab's threshold is `0.3 x ENERGY_MAX` (`30` in points, `0.3` as a fraction): an `info`
// or `confirm` item carrying the entity's new source before the write updates the value the
// write carries (the X0/1c window of 7.5), and the `repair` (E2) after the write queues the
// canned repair operation `crab.energy < 30` -> `crab.energy < 0.3` — the number scaled to the
// `after` the item shows — and the acknowledgement of 7.5 step 6.

import type { HeadsUp } from "../../protocol/headsup.ts";
import { energyMaxOf, sourceOf } from "../scripted.ts";
import { crabFile, crabThreshold } from "./canned.ts";
import { cannedCast, type CastCall, type CastState } from "./runner.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";
const PATH = "creatures/crab.js";

const E2_STATEMENT = "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.";

/** The threshold text the crab's file holds or will hold: `30` while energy is in points. */
function threshold(s: CastState): string {
  const v = (s.data.v ?? 100) as number;
  return crabThreshold(v);
}

/** An item that shows `ENERGY_MAX`'s new source updates `v`; once the write is recorded the
 * same change is applied to the file as the canned repair (chained off the queue's tail). */
function takeEnergyValue(s: CastState, hu: HeadsUp, ack: { statement: string }): void {
  for (const item of hu.items) {
    if (item.premise.kind !== "entity" || item.premise.key !== ENERGY_KEY || item.diff.kind !== "entity") {
      continue;
    }
    const v = energyMaxOf(item.diff.after);
    if (v === null) continue;
    s.data.v = v;
    const next = crabThreshold(v);
    const written = s.data.threshold as string | undefined;
    const tail = (s.queue.at(-1)?.args as { new?: string } | undefined)?.new;
    const cur = tail ?? written;
    if (cur !== undefined && cur !== next) {
      s.queue.push({
        tool: "replace",
        args: { path: PATH, old: `crab.energy < ${cur}`, new: `crab.energy < ${next}` },
        why: "repair",
      });
    }
    ack.statement = E2_STATEMENT;
  }
}

export const HERO_C = cannedCast({
  id: "hero-c",
  intent: "a crab that hides in its shell when its energy drops below 30",
  truth: [
    `entity:${ENERGY_KEY}`,
    "entity:world/bounds.js#FLOOR_Y",
    "entity:world/bounds.js#bounce",
    "entity:world/movement.js#step",
  ],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" }, why: "energy" },
    { tool: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" }, why: "read" },
    { tool: "read", args: { path: "world/bounds.js", entity: "bounce" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "step" }, why: "read" },
    {
      tool: "write",
      args: (s) => {
        s.data.pending = threshold(s); // the text issued; `write` adopts it when confirmed
        return { path: PATH, content: crabFile(s.data.pending as string) };
      },
      why: "write",
    },
  ],

  onResult(s, call, result) {
    if (call.why === "energy") {
      const v = energyMaxOf(sourceOf(result));
      if (v !== null) s.data.v = v;
      return;
    }
    if (call.why === "write") {
      // The file now holds the threshold it was written with; chained repairs chain off it.
      s.data.threshold = s.data.pending;
      return;
    }
  },

  onHeadsUp(s, hu, ack) {
    if (hu.result === "info" || hu.result === "confirm" || hu.result === "repair") {
      takeEnergyValue(s, hu, ack);
    }
  },
});
