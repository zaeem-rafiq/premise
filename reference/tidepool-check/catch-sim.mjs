import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool");
const hero = (n) => readFileSync("hero/" + n + ".js", "utf8");
const OLD = "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const NEW = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";

// ---------- finish order 2 properly
const A = { S: { intent: "make energy a fraction from 0 to 1" }, C: { intent: "crab" }, H: { intent: "shrimp" } };
const c2 = run("ORDER 2 complete", seed, A, [
  { by: "S", do: "read", args: { path: "world/energy.js" } },
  { by: "S", do: "replace", args: { path: "world/energy.js", old: OLD, new: NEW } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction: ENERGY_MAX is 1" } },
  { by: "C", do: "read", args: { path: "world/energy.js" } }, { by: "C", do: "read", args: { path: "world/bounds.js" } }, { by: "C", do: "read", args: { path: "world/movement.js" } },
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: hero("crab") } },
  { by: "C", do: "submit", args: { summary: "Add a crab" } },
  { by: "H", do: "read", args: { path: "world/energy.js" } }, { by: "H", do: "read", args: { path: "world/bounds.js" } }, { by: "H", do: "read", args: { path: "world/movement.js" } }, { by: "H", do: "read", args: { path: "world/time.js" } },
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: hero("shrimp") } },
  { by: "H", do: "submit", args: { summary: "Add a shrimp" } },
  { do: "tick" }, { do: "push_ok" },
  { by: "S", do: "read", args: { path: "creatures/crab.js" } },
  { by: "S", do: "replace", args: { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" } },
  { by: "S", do: "read", args: { path: "creatures/shrimp.js" } },
  { by: "S", do: "replace", args: { path: "creatures/shrimp.js", old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction", acknowledge: [1], statement: "Two new creatures used point values; rescaled them in the same change." } },
  { by: "S", do: "submit", args: { summary: "Make energy a fraction", acknowledge: [2], statement: "The creature functions I edited call step, bounce, seconds, wander and glide; none of them deals with energy." } },
  { do: "owner", args: { action: "land", attempt: "S" } },
  { do: "tick" }, { do: "push_ok" },
]);
console.log("final:", c2.head.files["creatures/crab.js"].split("\n").find((l) => l.includes("crab.energy <")).trim(), "|", c2.head.files["creatures/shrimp.js"].split("\n").find((l) => l.includes("drain(")).trim(), "|", c2.head.files["world/energy.js"].split("\n")[1]);

// ---------- second catch: gold sweep, B lands mid-sweep (L1)
const G = { A: { intent: "repaint every creature in gold" }, B: { intent: "a seahorse that bobs up and down" } };
const sweepReads = [
  { by: "A", do: "list", args: { path: "creatures/" }, showPremises: true },
  { by: "A", do: "read", args: { path: "creatures/anemone.js" } },
  { by: "A", do: "replace", args: { path: "creatures/anemone.js", old: 'const ARMS = "pink";', new: 'const ARMS = "gold";' }, showPremises: true },
  { by: "A", do: "replace", args: { path: "creatures/anemone.js", old: 'const BASE = "purple";', new: 'const BASE = "#b8860b";' } },
  { by: "A", do: "read", args: { path: "creatures/fish.js" } },
  { by: "A", do: "replace", args: { path: "creatures/fish.js", old: 'const BODY = "orange";', new: 'const BODY = "gold";' } },
  { by: "A", do: "replace", args: { path: "creatures/fish.js", old: 'const FIN = "yellow";', new: 'const FIN = "#b8860b";' } },
];
const sweepRest = [
  { by: "A", do: "read", args: { path: "creatures/minnow.js" } },
  { by: "A", do: "replace", args: { path: "creatures/minnow.js", old: 'const BODY = "silver";', new: 'const BODY = "gold";' } },
  { by: "A", do: "read", args: { path: "creatures/snail.js" } },
  { by: "A", do: "replace", args: { path: "creatures/snail.js", old: 'const SHELL = "brown";', new: 'const SHELL = "gold";' } },
  { by: "A", do: "replace", args: { path: "creatures/snail.js", old: 'const BODY = "sand";', new: 'const BODY = "#b8860b";' } },
  { by: "A", do: "read", args: { path: "creatures/turtle.js" } },
  { by: "A", do: "replace", args: { path: "creatures/turtle.js", old: 'const SHELL = "green";', new: 'const SHELL = "gold";' } },
  { by: "A", do: "replace", args: { path: "creatures/turtle.js", old: 'const SKIN = "teal";', new: 'const SKIN = "#b8860b";' } },
];
const bAdd = [
  { by: "B", do: "list", args: { path: "creatures/" } },
  { by: "B", do: "read", args: { path: "creatures/fish.js" } },
  { by: "B", do: "read", args: { path: "world/bounds.js" } },
  { by: "B", do: "write", args: { path: "creatures/seahorse.js", content: hero("seahorse") } },
  { by: "B", do: "submit", args: { summary: "Add a seahorse" }, showPremises: true },
];
run("GOLD order 1: the seahorse lands while the sweep is in flight", seed, G, [
  ...sweepReads, ...bAdd, { do: "tick" }, { do: "push_ok" },
  ...sweepRest,
  { by: "A", do: "read", args: { path: "creatures/seahorse.js" } },
  { by: "A", do: "replace", args: { path: "creatures/seahorse.js", old: 'const BODY = "pink";', new: 'const BODY = "gold";' } },
  { by: "A", do: "submit", args: { summary: "Repaint every creature in gold", acknowledge: [1], statement: "A seahorse arrived during the repaint; painted it gold too." } },
  { do: "tick" }, { do: "push_ok" },
]);
run("GOLD order 1 early: the seahorse lands after A listed but before A's first edit", seed, G, [
  { by: "A", do: "list", args: { path: "creatures/" } },
  ...bAdd, { do: "tick" }, { do: "push_ok" },
  { by: "A", do: "read", args: { path: "creatures/anemone.js" }, note: "A's next call: any heads-up?" },
]);
run("GOLD order 2: the sweep lands first, the seahorse is in flight (it read fish.js as an example, already wrote)", seed, G, [
  ...bAdd.slice(0, 4),
  ...sweepReads, ...sweepRest,
  { by: "A", do: "submit", args: { summary: "Repaint every creature in gold" } },
  { do: "tick" }, { do: "push_ok" },
  { by: "B", do: "submit", args: { summary: "Add a seahorse" } },
]);
run("GOLD order 2 early: the sweep lands first, the seahorse agent has read fish.js but written nothing", seed, G, [
  ...bAdd.slice(0, 3),
  ...sweepReads, ...sweepRest,
  { by: "A", do: "submit", args: { summary: "Repaint every creature in gold" } },
  { do: "tick" }, { do: "push_ok" },
]);

// ---------- search sweep: wrap( -> bounce(
const W = { A: { intent: "creatures must turn around at the side walls instead of coming back on the other side" }, B: { intent: "a ray that glides across and comes back on the other side" } };
run("WRAP search sweep: the ray lands mid-sweep (QT1)", seed, W, [
  { by: "A", do: "search", args: { query: "wrap(", path: "creatures/" }, showPremises: true },
  { by: "A", do: "read", args: { path: "creatures/fish.js" } },
  { by: "A", do: "read", args: { path: "world/bounds.js" } },
  { by: "A", do: "replace", args: { path: "creatures/fish.js", old: "  wrap(fish);", new: "  bounce(fish);" } },
  { by: "A", do: "replace", args: { path: "creatures/fish.js", old: 'import { wrap } from "../world/bounds.js";', new: 'import { bounce } from "../world/bounds.js";' } },
  { by: "B", do: "read", args: { path: "world/bounds.js" } }, { by: "B", do: "read", args: { path: "world/movement.js" } },
  { by: "B", do: "write", args: { path: "creatures/ray.js", content: hero("ray") } },
  { by: "B", do: "submit", args: { summary: "Add a ray" } },
  { do: "tick" }, { do: "push_ok" },
]);
run("WRAP search sweep early: the ray lands after the search, before the first edit (X0)", seed, W, [
  { by: "A", do: "search", args: { query: "wrap(", path: "creatures/" } },
  { by: "B", do: "read", args: { path: "world/bounds.js" } }, { by: "B", do: "read", args: { path: "world/movement.js" } },
  { by: "B", do: "write", args: { path: "creatures/ray.js", content: hero("ray") } },
  { by: "B", do: "submit", args: { summary: "Add a ray" } },
  { do: "tick" }, { do: "push_ok" },
]);
