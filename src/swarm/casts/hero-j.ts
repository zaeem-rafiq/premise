// `hero-j` — attempt J of 02-tidepool.md 7.3: `list creatures/`; `read GUIDE.md`; `read` the
// entities `bounds#SURFACE_Y`, `bounds#FLOOR_Y`; `write` creatures/jellyfish.js (the canned
// file, verbatim); `submit`. J references nothing about energy: it is in the cast to show
// who is not disturbed (7.7). It takes the SW6 defaults for any heads-up.

import { JELLYFISH_FILE } from "./canned.ts";
import { cannedCast } from "./runner.ts";

export const HERO_J = cannedCast({
  id: "hero-j",
  intent: "a jellyfish that drifts up and down",
  truth: ["entity:world/bounds.js#SURFACE_Y", "entity:world/bounds.js#FLOOR_Y"],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" }, why: "read" },
    { tool: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" }, why: "read" },
    { tool: "write", args: { path: "creatures/jellyfish.js", content: JELLYFISH_FILE }, why: "write" },
  ],
});
