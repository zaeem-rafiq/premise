// `wrap-b` — attempt B of 02-tidepool.md 8.6: `list creatures/`; `read GUIDE.md`; `read` the
// entities `world/bounds.js#wrap` and `world/movement.js#step`; `write` creatures/ray.js (the
// canned file of 10.5, verbatim); `submit`. A `wrap` that has since been renamed or that became
// a search catch is the engine's `repair`; the scripted run shows the informational side (8.6).

import { RAY_FILE } from "./canned.ts";
import { cannedCast } from "./runner.ts";

export const WRAP_B = cannedCast({
  id: "wrap-b",
  intent: "a ray that swims out one side and back in the other",
  truth: ["entity:world/bounds.js#wrap", "entity:world/movement.js#step"],
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/bounds.js", entity: "wrap" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "step" }, why: "read" },
    { tool: "write", args: { path: "creatures/ray.js", content: RAY_FILE }, why: "write" },
  ],
});
