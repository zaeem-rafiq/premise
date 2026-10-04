// `gold-b` — attempt B of 02-tidepool.md 8.2: `list creatures/`; `read GUIDE.md`;
// `read creatures/fish.js`; `read world/bounds.js`; `write` creatures/seahorse.js (the canned
// file, verbatim); `submit`. 8.4 says what B hears when the repaint lands while it is in flight
// (X0 `info`, or F4 triage — `holds` under scripted triage); either way there is nothing for a
// canned seahorse to change.

import { SEAHORSE_FILE } from "./canned.ts";
import { cannedCast } from "./runner.ts";

export const GOLD_B = cannedCast({
  id: "gold-b",
  intent: "a seahorse that bobs up and down",
  truth: ["entity:world/bounds.js#SURFACE_Y", "entity:world/bounds.js#FLOOR_Y"],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "creatures/fish.js" }, why: "example" },
    { tool: "read", args: { path: "world/bounds.js" }, why: "read" },
    { tool: "write", args: { path: "creatures/seahorse.js", content: SEAHORSE_FILE }, why: "write" },
  ],
});
