import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool2");
const hero = (n) => readFileSync("hero/" + n + ".js", "utf8");
const OLD = "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const NEW = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";
const A = { S: { intent: "make energy a fraction from 0 to 1" }, C: { intent: "crab" }, H: { intent: "shrimp" }, J: { intent: "jellyfish" } };
const C = [
  { by: "C", do: "list", args: { path: "creatures/" } },
  { by: "C", do: "read", args: { path: "GUIDE.md" } },
  { by: "C", do: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } },
  { by: "C", do: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } },
  { by: "C", do: "read", args: { path: "world/bounds.js", entity: "bounce" } },
  { by: "C", do: "read", args: { path: "world/movement.js", entity: "step" } },
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: hero("crab") }, showPremises: true },
];
const H = [
  { by: "H", do: "list", args: { path: "creatures/" } },
  { by: "H", do: "read", args: { path: "GUIDE.md" } },
  { by: "H", do: "read", args: { path: "world/energy.js" } },
  { by: "H", do: "read", args: { path: "world/bounds.js" } },
  { by: "H", do: "read", args: { path: "world/time.js" } },
  { by: "H", do: "read", args: { path: "world/movement.js" } },
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: hero("shrimp") } },
];
const J = [
  { by: "J", do: "list", args: { path: "creatures/" } },
  { by: "J", do: "read", args: { path: "GUIDE.md" } },
  { by: "J", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } },
  { by: "J", do: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } },
  { by: "J", do: "write", args: { path: "creatures/jellyfish.js", content: hero("jellyfish") } },
];
const core = run("CANNED ORDER 1", seed, A, [
  ...C, ...H, ...J,
  { by: "S", do: "read", args: { path: "GUIDE.md" } },
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction from 0 to 1" }, showPremises: true },
  { do: "owner", args: { action: "land", attempt: "S" } },
  { do: "tick" }, { do: "push_ok" },
  { by: "C", do: "replace", args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" } },
  { by: "C", do: "submit", args: { summary: "Add a crab that hides when its energy is low", acknowledge: [1], statement: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3." }, showPremises: true },
  { by: "H", do: "replace", args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" } },
  { by: "H", do: "submit", args: { summary: "Add a shrimp that darts", acknowledge: [1], statement: "Energy is now a fraction from 0 to 1, so a dart costs 0.05." }, showPremises: true },
  { by: "J", do: "submit", args: { summary: "Add a jellyfish" }, showPremises: true },
  { do: "tick" }, { do: "push_ok" },
]);
for (const n of ["C", "H", "J", "S"]) { const a = core.attempts.get(n); console.log(n, a.state, "go_arounds", a.go_arounds, "landed_seq", a.landed_seq); }
for (const n of ["C", "H", "J"]) { const a = core.attempts.get(n); console.log(n, "premises:", [...a.premises.values()].map((p) => `${p.kind}:${p.key}[${p.read ? "r" : ""}${p.edit ? "e" : ""}${p.derived ? "d" : ""}]`).join(", ")); }
