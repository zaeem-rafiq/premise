// `sweep-b` — attempt P9b of 02-tidepool.md 9.5: `list creatures/`; `read GUIDE.md`; `read` the
// entities `energy#ENERGY_MAX`, `energy#drain`, `bounds#bounce`, `time#seconds`,
// `movement#step`, `#wander`, `#glide`; `write` creatures/squid.js (the canned file); `submit`.
//
// The squid's burst spends a tenth of a tank: `drain(squid, 0.1)` while `drain` takes energy,
// `drain(squid, 10)` once `drain` takes percent. The `repair` (E2 on `entity:energy.js#drain`,
// the other order of row A20) rewrites the number — the `after` that says `percent` decides —
// or, arriving before the write, decides the number the write carries.

import type { HeadsUp } from "../../protocol/headsup.ts";
import { squidFile } from "./canned.ts";
import { cannedCast, type CastState } from "./runner.ts";

const DRAIN_KEY = "world/energy.js#drain";
const PATH = "creatures/squid.js";

/** The squid's drain argument: `0.1` of the tank while `drain` takes energy, `10` in percent. */
function cost(s: CastState): string {
  return s.data.percent === true ? "10" : "0.1";
}

function takeDrain(s: CastState, hu: HeadsUp, ack: { statement: string }): void {
  for (const item of hu.items) {
    if (item.premise.kind !== "entity" || item.premise.key !== DRAIN_KEY || item.diff.kind !== "entity") {
      continue;
    }
    const after = item.diff.after ?? "";
    if (!/\bpercent\b/.test(after)) continue;
    s.data.percent = true;
    const cur = (s.data.cost as string | undefined) ?? null;
    if (cur !== null && cur !== "10") {
      s.queue.push({
        tool: "replace",
        args: { path: PATH, old: `drain(squid, ${cur})`, new: "drain(squid, 10)" },
        why: "repair",
      });
    }
    ack.statement = "drain now takes percent; rewrote the burst to 10";
  }
}

export const SWEEP_B = cannedCast({
  id: "sweep-b",
  intent: "a squid that shoots forward every three seconds and spends a tenth of its energy on each burst",
  truth: [
    "entity:world/energy.js#ENERGY_MAX",
    `entity:${DRAIN_KEY}`,
    "entity:world/bounds.js#bounce",
    "entity:world/time.js#seconds",
    "entity:world/movement.js#step",
    "entity:world/movement.js#wander",
    "entity:world/movement.js#glide",
  ],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" }, why: "read" },
    { tool: "read", args: { path: "world/energy.js", entity: "drain" }, why: "read" },
    { tool: "read", args: { path: "world/bounds.js", entity: "bounce" }, why: "read" },
    { tool: "read", args: { path: "world/time.js", entity: "seconds" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "step" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "wander" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "glide" }, why: "read" },
    {
      tool: "write",
      args: (s) => {
        s.data.pending = cost(s); // the number issued; `write` adopts it when confirmed
        return { path: PATH, content: squidFile(s.data.pending as string) };
      },
      why: "write",
    },
  ],

  onResult(s, call) {
    if (call.why === "write") s.data.cost = s.data.pending;
  },

  onHeadsUp(s, hu, ack) {
    takeDrain(s, hu, ack);
  },
});
