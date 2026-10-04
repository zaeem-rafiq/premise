import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool");
const crab = readFileSync("hero/crab.js", "utf8");
const shrimp = readFileSync("hero/shrimp.js", "utf8");
const jelly = readFileSync("hero/jellyfish.js", "utf8");
const OLD = "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const NEW = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";
const A = { S: { intent: "make energy a fraction from 0 to 1" }, C: { intent: "a crab that hides in its shell when its energy drops below 30" }, H: { intent: "a shrimp that darts every two seconds and spends 5 energy on each dart" }, J: { intent: "a jellyfish that drifts up and down" } };

// ---- order 1: shared rule lands first
run("ORDER 1: S lands first (crab read the entity, shrimp read the whole file, jellyfish read nothing about energy)", seed, A, [
  { by: "C", do: "list", args: { path: "creatures/" } },
  { by: "C", do: "read", args: { path: "creatures/README.md" } },
  { by: "C", do: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" }, showPremises: true },
  { by: "C", do: "outline", args: { path: "world/bounds.js" } },
  { by: "C", do: "outline", args: { path: "world/movement.js" } },
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  { by: "H", do: "list", args: { path: "creatures/" } },
  { by: "H", do: "read", args: { path: "world/energy.js" }, showPremises: true },
  { by: "H", do: "read", args: { path: "world/movement.js" } },
  { by: "H", do: "read", args: { path: "world/bounds.js" } },
  { by: "H", do: "read", args: { path: "world/time.js" } },
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: shrimp } },
  { by: "J", do: "list", args: { path: "creatures/" } },
  { by: "J", do: "read", args: { path: "world/bounds.js" } },
  { by: "J", do: "write", args: { path: "creatures/jellyfish.js", content: jelly } },
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW }, showPremises: true },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction: ENERGY_MAX is 1" } },
  { do: "owner", args: { action: "land", attempt: "S" } },
  { do: "tick" },
  { do: "push_ok" },
  { by: "C", do: "replace", args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" } },
  { by: "C", do: "submit", args: { summary: "Add a crab that hides when its energy is low", acknowledge: [1], statement: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3." }, showPremises: true },
  { by: "H", do: "replace", args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" } },
  { by: "H", do: "submit", args: { summary: "Add a shrimp that darts", acknowledge: [1], statement: "Energy is now a fraction from 0 to 1, so a dart costs 0.05." } },
  { by: "J", do: "submit", args: { summary: "Add a jellyfish" }, showPremises: true },
  { do: "tick" },
  { do: "push_ok" },
]);
