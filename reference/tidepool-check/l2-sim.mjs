import { readFileSync } from "node:fs";
import { loadFiles, run } from "./simlib.mjs";
const seed = loadFiles("pool2");
const hero = (n) => readFileSync("hero/" + n + ".js", "utf8");
const cleaner = `import { keepInside } from "../world/bounds.js";
import { step, steer, glide } from "../world/movement.js";

const BODY = "blue";

export function spawn() {
  return {};
}

export function update(cleaner, world) {
  const turtle = world.creatures.find((other) => other.kind === "turtle");
  if (turtle) steer(cleaner, turtle.x, turtle.y, 0.1);
  glide(cleaner, 0.95);
  step(cleaner);
  keepInside(cleaner);
}

export function draw(cleaner, pen) {
  pen.fill(BODY);
  pen.ellipse(0, 0, 10, 5);
}
`;
run("A12 cleaner names the turtle; a jellyfish lands", seed, { A: { intent: "cleaner" }, B: { intent: "jellyfish" } }, [
  { by: "A", do: "list", args: { path: "creatures/" } },
  { by: "A", do: "read", args: { path: "world/movement.js" } }, { by: "A", do: "read", args: { path: "world/bounds.js" } },
  { by: "A", do: "write", args: { path: "creatures/cleaner.js", content: cleaner } },
  { by: "B", do: "read", args: { path: "world/bounds.js" } },
  { by: "B", do: "write", args: { path: "creatures/jellyfish.js", content: hero("jellyfish") } },
  { by: "B", do: "submit", args: { summary: "Add a jellyfish" } }, { do: "tick" }, { do: "push_ok" },
]);
