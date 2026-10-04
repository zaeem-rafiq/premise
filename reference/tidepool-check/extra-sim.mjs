import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool2");
const hero = (n) => readFileSync("hero/" + n + ".js", "utf8");
const C = [
  { by: "C", do: "list", args: { path: "creatures/" } }, { by: "C", do: "read", args: { path: "GUIDE.md" } },
  { by: "C", do: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } }, { by: "C", do: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } },
  { by: "C", do: "read", args: { path: "world/bounds.js", entity: "bounce" } }, { by: "C", do: "read", args: { path: "world/movement.js", entity: "step" } },
  { by: "C", do: "write", args: { path: "creatures/crab.js", content: hero("crab") } },
];
const H = [
  { by: "H", do: "list", args: { path: "creatures/" } }, { by: "H", do: "read", args: { path: "GUIDE.md" } },
  { by: "H", do: "read", args: { path: "world/energy.js" } }, { by: "H", do: "read", args: { path: "world/bounds.js" } },
  { by: "H", do: "read", args: { path: "world/time.js" } }, { by: "H", do: "read", args: { path: "world/movement.js" } },
  { by: "H", do: "write", args: { path: "creatures/shrimp.js", content: hero("shrimp") } },
];
const J = [
  { by: "J", do: "list", args: { path: "creatures/" } }, { by: "J", do: "read", args: { path: "GUIDE.md" } },
  { by: "J", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } }, { by: "J", do: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } },
  { by: "J", do: "write", args: { path: "creatures/jellyfish.js", content: hero("jellyfish") } },
];
const names = { C: { intent: "crab" }, H: { intent: "shrimp" }, J: { intent: "jelly" }, T: { intent: "t" } };
run("7.7 cosmetic", seed, names, [...C, ...H, ...J,
  { by: "T", do: "read", args: { path: "world/energy.js" } },
  { by: "T", do: "replace", args: { path: "world/energy.js", old: "// What one tick of ordinary living costs.", new: "// The cost of one tick of ordinary living." } },
  { by: "T", do: "submit", args: { summary: "Reword a comment" } }, { do: "owner", args: { action: "land", attempt: "T" } }, { do: "tick" }, { do: "push_ok" },
]);
run("7.7 REST_TICKS", seed, names, [...C, ...H, ...J,
  { by: "T", do: "read", args: { path: "world/energy.js", entity: "REST_TICKS" } },
  { by: "T", do: "replace", args: { path: "world/energy.js", old: "REST_TICKS = 300", new: "REST_TICKS = 150" } },
  { by: "T", do: "submit", args: { summary: "Halve the rest" } }, { do: "owner", args: { action: "land", attempt: "T" } }, { do: "tick" }, { do: "push_ok" },
]);
// 8.3 with A finished all five files
const sweep = [
  ["anemone.js", 'const ARMS = "pink";', 'const ARMS = "gold";'], ["anemone.js", 'const BASE = "purple";', 'const BASE = "#b8860b";'],
  ["fish.js", 'const BODY = "orange";', 'const BODY = "gold";'], ["fish.js", 'const FIN = "yellow";', 'const FIN = "#b8860b";'],
  ["minnow.js", 'const BODY = "silver";', 'const BODY = "gold";'],
  ["snail.js", 'const SHELL = "brown";', 'const SHELL = "gold";'], ["snail.js", 'const BODY = "sand";', 'const BODY = "#b8860b";'],
  ["turtle.js", 'const SHELL = "green";', 'const SHELL = "gold";'], ["turtle.js", 'const SKIN = "teal";', 'const SKIN = "#b8860b";'],
];
const A = [{ by: "A", do: "list", args: { path: "creatures/" } }];
let last = null;
for (const [f, o, n] of sweep) { if (f !== last) A.push({ by: "A", do: "read", args: { path: "creatures/" + f } }); last = f; A.push({ by: "A", do: "replace", args: { path: "creatures/" + f, old: o, new: n } }); }
const B = [
  { by: "B", do: "list", args: { path: "creatures/" } }, { by: "B", do: "read", args: { path: "GUIDE.md" } }, { by: "B", do: "read", args: { path: "creatures/fish.js" } }, { by: "B", do: "read", args: { path: "world/bounds.js" } },
  { by: "B", do: "write", args: { path: "creatures/seahorse.js", content: hero("seahorse") } }, { by: "B", do: "submit", args: { summary: "Add a seahorse" } },
];
const g = run("8.3 A finished five files, holds before submit; B lands", seed, { A: { intent: "gold" }, B: { intent: "seahorse" } }, [
  ...A, ...B, { do: "tick" }, { do: "push_ok" },
  { by: "A", do: "read", args: { path: "creatures/seahorse.js" } },
  { by: "A", do: "replace", args: { path: "creatures/seahorse.js", old: 'const BODY = "pink";', new: 'const BODY = "gold";' } },
  { by: "A", do: "submit", args: { summary: "Repaint every creature in gold", acknowledge: [1], statement: "A seahorse arrived during the repaint. Painted it gold too." } },
  { do: "tick" }, { do: "push_ok" },
]);
console.log("A ops:", g.attempts.get("A").ops.length, "state", g.attempts.get("A").state, "seahorse:", g.head.files["creatures/seahorse.js"].split("\n")[2]);

// pairs order 2 and P8
const lily = `import { SURFACE_Y } from "../world/bounds.js";\n\nconst PAD = "green";\n\nexport function spawn() {\n  return { y: SURFACE_Y };\n}\n\nexport function update(lily, world) {\n  lily.x += Math.sin(world.tick / 60 + lily.id) * 0.2;\n  lily.y = SURFACE_Y;\n}\n\nexport function draw(lily, pen) {\n  pen.fill(PAD);\n  pen.ellipse(0, 0, 22, 6);\n}\n`;
run("P6 order 2: lily lands while the water-line change is in flight", seed, { A: { intent: "lower the water line" }, B: { intent: "lily" } }, [
  { by: "A", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } },
  { by: "A", do: "replace", args: { path: "world/bounds.js", old: "SURFACE_Y = 40", new: "SURFACE_Y = 120" } },
  { by: "B", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } },
  { by: "B", do: "write", args: { path: "creatures/lily.js", content: lily } },
  { by: "B", do: "submit", args: { summary: "Add a lily pad" } }, { do: "tick" }, { do: "push_ok" },
]);
run("P7 order 2: ray lands while the wrap change is in flight", seed, { A: { intent: "solid walls" }, B: { intent: "ray" } }, [
  { by: "A", do: "read", args: { path: "world/bounds.js" } },
  { by: "A", do: "replace", args: { path: "world/bounds.js", old: "  if (creature.x < 0) creature.x += POOL_WIDTH;\n  if (creature.x > POOL_WIDTH) creature.x -= POOL_WIDTH;\n  creature.y = Math.min(FLOOR_Y, Math.max(SURFACE_Y, creature.y));", new: "  bounce(creature);" } },
  { by: "B", do: "read", args: { path: "world/bounds.js", entity: "wrap" } }, { by: "B", do: "read", args: { path: "world/movement.js", entity: "step" } },
  { by: "B", do: "write", args: { path: "creatures/ray.js", content: hero("ray") } },
  { by: "B", do: "submit", args: { summary: "Add a ray" } }, { do: "tick" }, { do: "push_ok" },
]);
const sail = `import { MAX_SPEED, step } from "../world/movement.js";\nimport { wrap } from "../world/bounds.js";\n\nconst BODY = "blue";\n\nexport function spawn() {\n  return { vx: MAX_SPEED };\n}\n\nexport function update(sailfish) {\n  sailfish.vx = sailfish.vx < 0 ? -MAX_SPEED : MAX_SPEED;\n  step(sailfish);\n  wrap(sailfish);\n}\n\nexport function draw(sailfish, pen) {\n  pen.fill(BODY);\n  pen.ellipse(0, 0, 22, 7);\n}\n`;
const sailReads = [{ by: "B", do: "read", args: { path: "world/movement.js", entity: "MAX_SPEED" } }, { by: "B", do: "read", args: { path: "world/movement.js", entity: "step" } }, { by: "B", do: "read", args: { path: "world/bounds.js", entity: "wrap" } }, { by: "B", do: "write", args: { path: "creatures/sailfish.js", content: sail } }];
const speed = [{ by: "A", do: "read", args: { path: "world/movement.js", entity: "MAX_SPEED" } }, { by: "A", do: "replace", args: { path: "world/movement.js", old: "MAX_SPEED = 3", new: "MAX_SPEED = 4.5" } }];
run("P8 order 1: top speed lands while the sailfish is in flight", seed, { A: { intent: "top speed" }, B: { intent: "sailfish" } }, [
  ...sailReads, ...speed, { by: "A", do: "submit", args: { summary: "Raise top speed" } }, { do: "owner", args: { action: "land", attempt: "A" } }, { do: "tick" }, { do: "push_ok" },
]);
run("P8 order 2: sailfish lands while the top speed change is in flight", seed, { A: { intent: "top speed" }, B: { intent: "sailfish" } }, [
  ...speed, ...sailReads, { by: "B", do: "submit", args: { summary: "Add a sailfish" } }, { do: "tick" }, { do: "push_ok" },
]);
// P4 order 2
run("P4 order 2: halve lands while double is in flight", seed, { A: { intent: "double" }, B: { intent: "halve" } }, [
  { by: "A", do: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } }, { by: "B", do: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } },
  { by: "A", do: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 7200" } },
  { by: "B", do: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 1800" } },
  { by: "B", do: "submit", args: { summary: "Halve the day" } }, { do: "owner", args: { action: "land", attempt: "B" } }, { do: "tick" }, { do: "push_ok" },
]);
