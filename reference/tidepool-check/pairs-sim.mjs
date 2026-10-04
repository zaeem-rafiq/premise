import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool");
const hero = (n) => readFileSync("hero/" + n + ".js", "utf8");

run("P4 same entity: day twice as long vs day half as long", seed, { A: { intent: "make the day twice as long" }, B: { intent: "make the day half as long" } }, [
  { by: "A", do: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } },
  { by: "B", do: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } },
  { by: "A", do: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 7200" } },
  { by: "B", do: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 1800" } },
  { by: "A", do: "submit", args: { summary: "Double the day" } },
  { by: "B", do: "submit", args: { summary: "Halve the day" } },
  { do: "owner", args: { action: "land", attempt: "A" } },
  { do: "tick" }, { do: "push_ok" },
]);

const crab2 = hero("crab").replace("crab.hiding = crab.energy < 30;\n  if (crab.hiding) return;\n", "").replace(", energy: ENERGY_MAX, hiding: false", "");
run("P5 two crabs: both attempts create creatures/crab.js", seed, { A: { intent: "a crab that hides below 30" }, B: { intent: "a crab that walks sideways along the sand" } }, [
  { by: "A", do: "read", args: { path: "world/energy.js" } }, { by: "A", do: "read", args: { path: "world/bounds.js" } }, { by: "A", do: "read", args: { path: "world/movement.js" } },
  { by: "A", do: "write", args: { path: "creatures/crab.js", content: hero("crab") }, showPremises: true },
  { by: "B", do: "read", args: { path: "world/bounds.js" } }, { by: "B", do: "read", args: { path: "world/movement.js" } },
  { by: "B", do: "write", args: { path: "creatures/crab.js", content: hero("ray").replaceAll("ray", "crab").replace("wrap", "bounce").replace("wrap", "bounce") }, showPremises: true },
  { by: "A", do: "submit", args: { summary: "Add a crab" } },
  { by: "B", do: "submit", args: { summary: "Add a crab" } },
  { do: "tick" }, { do: "push_ok" },
]);

const lily = `import { SURFACE_Y } from "../world/bounds.js";

const PAD = "green";

export function spawn() {
  return { y: SURFACE_Y };
}

export function update(lily, world) {
  lily.x += Math.sin(world.tick / 60 + lily.id) * 0.2;
  lily.y = SURFACE_Y;
}

export function draw(lily, pen) {
  pen.fill(PAD);
  pen.ellipse(0, 0, 22, 6);
}
`;
run("P6 lily pad uses SURFACE_Y; the water line is lowered (E2, nothing to change)", seed, { A: { intent: "lower the water line so there is more sky" }, B: { intent: "a lily pad that floats on the water line" } }, [
  { by: "B", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } },
  { by: "B", do: "write", args: { path: "creatures/lily.js", content: lily } },
  { by: "A", do: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } },
  { by: "A", do: "replace", args: { path: "world/bounds.js", old: "SURFACE_Y = 40", new: "SURFACE_Y = 120" } },
  { by: "A", do: "submit", args: { summary: "Lower the water line" } },
  { do: "owner", args: { action: "land", attempt: "A" } },
  { do: "tick" }, { do: "push_ok" },
  { by: "B", do: "submit", args: { summary: "Add a lily pad", acknowledge: [1], statement: "The lily pad follows SURFACE_Y, so it still floats on the water line." } },
  { do: "tick" },
]);

run("R06 wrap changes meaning (body), the ray calls wrap (E2)", seed, { A: { intent: "side walls are solid: nothing comes back on the other side" }, B: { intent: "a ray that glides across and comes back on the other side" } }, [
  { by: "B", do: "read", args: { path: "world/bounds.js", entity: "wrap" } }, { by: "B", do: "read", args: { path: "world/movement.js", entity: "step" } },
  { by: "B", do: "write", args: { path: "creatures/ray.js", content: hero("ray") } },
  { by: "A", do: "read", args: { path: "world/bounds.js" } },
  { by: "A", do: "replace", args: { path: "world/bounds.js", old: "  if (creature.x < 0) creature.x += POOL_WIDTH;\n  if (creature.x > POOL_WIDTH) creature.x -= POOL_WIDTH;\n  creature.y = Math.min(FLOOR_Y, Math.max(SURFACE_Y, creature.y));", new: "  bounce(creature);" } },
  { by: "A", do: "submit", args: { summary: "Side walls are solid" } },
  { do: "owner", args: { action: "land", attempt: "A" } },
  { do: "tick" }, { do: "push_ok" },
]);
