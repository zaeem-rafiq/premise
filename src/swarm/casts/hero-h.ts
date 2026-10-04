// `hero-h` — attempt H of 02-tidepool.md 7.3: `list creatures/`; `read GUIDE.md`; `read` the
// whole files `world/energy.js`, `world/bounds.js`, `world/time.js`, `world/movement.js`;
// `write` creatures/shrimp.js (the canned file of 7.3); `submit`.
//
// The shrimp's dart costs a twentieth of a full tank (`drain(shrimp, 5)` in points,
// `drain(shrimp, 0.05)` as a fraction): a heads-up item carrying `ENERGY_MAX`'s new source
// before the write updates the number the write carries, and the `repair` (E2) after the
// write queues the canned repair operation `drain(shrimp, 5)` -> `drain(shrimp, 0.05)` with
// the acknowledgement of 7.5 step 7.

import type { HeadsUp } from "../../protocol/headsup.ts";
import { energyMaxOf, sourceOf } from "../scripted.ts";
import { dartCost, shrimpFile } from "./canned.ts";
import { cannedCast, type CastState } from "./runner.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";
const PATH = "creatures/shrimp.js";

const E2_STATEMENT = "Energy is now a fraction from 0 to 1, so a dart costs 0.05.";

function cost(s: CastState): string {
  const v = (s.data.v ?? 100) as number;
  return dartCost(v);
}

function takeEnergyValue(s: CastState, hu: HeadsUp, ack: { statement: string }): void {
  for (const item of hu.items) {
    if (item.premise.kind !== "entity" || item.premise.key !== ENERGY_KEY || item.diff.kind !== "entity") {
      continue;
    }
    const v = energyMaxOf(item.diff.after);
    if (v === null) continue;
    s.data.v = v;
    const next = dartCost(v);
    const written = s.data.cost as string | undefined;
    const tail = (s.queue.at(-1)?.args as { new?: string } | undefined)?.new;
    const cur = tail ?? written;
    if (cur !== undefined && cur !== next) {
      s.queue.push({
        tool: "replace",
        args: { path: PATH, old: `drain(shrimp, ${cur})`, new: `drain(shrimp, ${next})` },
        why: "repair",
      });
    }
    ack.statement = E2_STATEMENT;
  }
}

export const HERO_H = cannedCast({
  id: "hero-h",
  intent: "a shrimp that darts every two seconds and spends 5 energy on each dart",
  truth: [
    `entity:${ENERGY_KEY}`,
    "entity:world/energy.js#drain",
    "entity:world/bounds.js#bounce",
    "entity:world/time.js#seconds",
    "entity:world/movement.js#step",
    "entity:world/movement.js#wander",
    "entity:world/movement.js#glide",
  ],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/energy.js" }, why: "energy" },
    { tool: "read", args: { path: "world/bounds.js" }, why: "read" },
    { tool: "read", args: { path: "world/time.js" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js" }, why: "read" },
    {
      tool: "write",
      args: (s) => {
        s.data.pending = cost(s); // the text issued; `write` adopts it when confirmed
        return { path: PATH, content: shrimpFile(s.data.pending as string) };
      },
      why: "write",
    },
  ],

  onResult(s, call, result) {
    if (call.why === "energy") {
      const content = (result as { content?: unknown }).content;
      const v = energyMaxOf(sourceOf(result) ?? (typeof content === "string" ? content : null));
      if (v !== null) s.data.v = v;
      return;
    }
    if (call.why === "write") {
      s.data.cost = s.data.pending;
      return;
    }
  },

  onHeadsUp(s, hu, ack) {
    takeEnergyValue(s, hu, ack);
  },
});
