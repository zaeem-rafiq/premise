import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool");
const crab = readFileSync("hero/crab.js", "utf8");
const shrimp = readFileSync("hero/shrimp.js", "utf8");
const jelly = readFileSync("hero/jellyfish.js", "utf8");
const OLD = "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const NEW = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";
const A = { S: { intent: "make energy a fraction from 0 to 1" }, C: { intent: "a crab that hides in its shell when its energy drops below 30" }, H: { intent: "a shrimp that darts every two seconds and spends 5 energy on each dart" }, J: { intent: "a jellyfish that drifts up and down" } };
const readsC = [
  { by: "C", do: "read", args: { path: "world/energy.js" } },
  { by: "C", do: "read", args: { path: "world/bounds.js" } },
  { by: "C", do: "read", args: { path: "world/movement.js" } },
];
const readsH = [
  { by: "H", do: "read", args: { path: "world/energy.js" } },
  { by: "H", do: "read", args: { path: "world/movement.js" } },
  { by: "H", do: "read", args: { path: "world/bounds.js" } },
  { by: "H", do: "read", args: { path: "world/time.js" } },
];

// ---- order 2: creatures land first, S is held on its card
const c2 = run("ORDER 2: S has edited and waits on its held card; crab and shrimp land", seed, A, [
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction: ENERGY_MAX is 1" } },
  ...readsC,
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  { by: "C", do: "submit", args: { summary: "Add a crab that hides when its energy is low" }, showPremises: true },
  ...readsH,
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: shrimp } },
  { by: "H", do: "submit", args: { summary: "Add a shrimp that darts" } },
  { do: "tick" },
  { do: "push_ok" },
  { do: "owner", args: { action: "land", attempt: "S" }, note: "owner taps Land on the stale card" },
  { by: "S", do: "read", args: { path: "creatures/crab.js" } },
  { by: "S", do: "replace", args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" }, showPremises: true },
  { by: "S", do: "read", args: { path: "creatures/shrimp.js" } },
  { by: "S", do: "replace", args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction: ENERGY_MAX is 1", acknowledge: [1], statement: "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change." } },
  { do: "owner", args: { action: "land", attempt: "S" } },
  { do: "tick" },
  { do: "push_ok" },
]);
console.log("final crab line:", c2.head.files["creatures/crab.js"].split("\n").find((l) => l.includes("crab.energy <")));
console.log("final shrimp line:", c2.head.files["creatures/shrimp.js"].split("\n").find((l) => l.includes("drain(")));
console.log("final energy line:", c2.head.files["world/energy.js"].split("\n")[1]);

// ---- order 1, blind: the crab's agent learned the energy API from fish.js only
run("ORDER 1 BLIND: crab agent read only creatures/fish.js; S lands; crab submits", seed, A, [
  { by: "C", do: "read", args: { path: "creatures/fish.js" } },
  { by: "C", do: "read", args: { path: "world/bounds.js" } },
  { by: "C", do: "read", args: { path: "world/movement.js" } },
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction: ENERGY_MAX is 1" } },
  { do: "owner", args: { action: "land", attempt: "S" } },
  { do: "tick" },
  { do: "push_ok" },
  { by: "C", do: "submit", args: { summary: "Add a crab" }, showPremises: true },
  { by: "C", do: "replace", args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" } },
  { by: "C", do: "submit", args: { summary: "Add a crab", acknowledge: [1], statement: "ENERGY_MAX is 1, so the crab hides below 0.3." } },
  { do: "tick" },
  { do: "push_ok" },
]);

// ---- order 2b: S edits AFTER the crab landed (no anomaly; relied_on_by shows the crab)
run("ORDER 2b: crab lands, then S makes its edit", seed, A, [
  ...readsC,
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  { by: "C", do: "submit", args: { summary: "Add a crab" } },
  { do: "tick" },
  { do: "push_ok" },
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW } },
]);

// ---- cosmetic change to the hot file: nobody is disturbed
run("COSMETIC: a comment-only change to world/energy.js lands while crab and shrimp are in flight", seed, { ...A, T: { intent: "tidy the comments in the energy rules" } }, [
  ...readsC,
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  ...readsH,
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: shrimp } },
  { by: "T", do: "read", args: { path: "world/energy.js" } },
  { by: "T", do: "replace", args: { path: "world/energy.js", old: "// What one tick of ordinary living costs.", new: "// The cost of one tick of ordinary living." } },
  { by: "T", do: "submit", args: { summary: "Reword a comment" } },
  { do: "owner", args: { action: "land", attempt: "T" } },
  { do: "tick" },
  { do: "push_ok" },
  { by: "C", do: "submit", args: { summary: "Add a crab" } },
  { by: "H", do: "submit", args: { summary: "Add a shrimp" } },
  { do: "tick" },
]);

// ---- a different shared constant changes: REST_TICKS (crab read the whole file, does not reference it)
run("OTHER CONSTANT: REST_TICKS changes; crab read the whole energy file but does not use REST_TICKS", seed, { ...A, T: { intent: "tired creatures should rest for half as long" } }, [
  ...readsC,
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: crab } },
  { by: "H", do: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } },
  { by: "H", do: "read", args: { path: "world/energy.js", entity: "drain" } },
  { by: "H", do: "read", args: { path: "world/movement.js" } },
  { by: "H", do: "read", args: { path: "world/bounds.js" } },
  { by: "H", do: "read", args: { path: "world/time.js" } },
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: shrimp } },
  { by: "T", do: "read", args: { path: "world/energy.js", entity: "REST_TICKS" } },
  { by: "T", do: "replace", args: { path: "world/energy.js", old: "REST_TICKS = 300", new: "REST_TICKS = 150" } },
  { by: "T", do: "submit", args: { summary: "Halve the rest" } },
  { do: "owner", args: { action: "land", attempt: "T" } },
  { do: "tick" },
]);
