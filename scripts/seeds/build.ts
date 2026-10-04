// `npm run build:seeds` (docs/spec/04-build-plan.md 1.5): writes the seed bundle, dist/seeds.json.
//
// The bundle holds the three seed trees that 01-core.md PL1 names: `tidepool` (the stored tree of
// seeds/tidepool/), `tidepool-auto` and `tidepool-swarm`. The variants are generated, never stored
// (plan 1.1; 02-tidepool.md section 6): `tidepool-auto` is the same tree with the one-line policy
// variant that puts the files directly in `world/` on tier `auto`; `tidepool-swarm` is that tree
// plus the four scripted creatures of 02-tidepool.md 10.1 (template T-plain of 10.2).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_DIRECTORY = join(repoRoot, "seeds", "tidepool");
const BUNDLE_FILE = join(repoRoot, "dist", "seeds.json");

/** One seed tree: the path of each file inside the tree to its contents. */
export type SeedTree = ReadonlyMap<string, string>;

/** Every file of the stored seed `tidepool`, as `path -> contents`, sorted by path. */
export function readSeed(directory: string = SEED_DIRECTORY): SeedTree {
  const tree = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) tree.set(path, readFileSync(join(directory, path), "utf8"));
    }
  };
  visit("");
  return new Map([...tree].sort(([a], [b]) => a.localeCompare(b)));
}

// The one line of `.premise/policy.json` that section 6 changes for both generated seeds.
const STORED_TIER = `{ "paths": ["creatures/*.js"], "tier": "auto" }`;
const VARIANT_TIER = `{ "paths": ["creatures/*.js", "world/*.js"], "tier": "auto" }`;

/** The section-6 policy variant: the first tier's paths gain `"world/*.js"`. Everything else is the seed. */
export function withAutoPolicy(seed: SeedTree): SeedTree {
  const policy = seed.get(".premise/policy.json");
  if (policy === undefined) throw new Error("the seed has no .premise/policy.json");
  if (!policy.includes(STORED_TIER)) {
    throw new Error(".premise/policy.json does not hold the tier line that section 6 changes.");
  }
  const tree = new Map(seed);
  tree.set(".premise/policy.json", policy.replace(STORED_TIER, VARIANT_TIER));
  return tree;
}

// The four scripted creatures of 10.1: file name, then the `{colour}` and `{speed}` of template
// T-plain of 10.2.
const SWARM_CREATURES: ReadonlyArray<readonly [path: string, colour: string, speed: string]> = [
  ["creatures/s0000.js", "teal", "1"],
  ["creatures/s0001.js", "red", "1.5"],
  ["creatures/s0002.js", "blue", "2"],
  ["creatures/s0003.js", "green", "2.5"],
];

/** Template T-plain of 02-tidepool.md 10.2 with `{colour}` and `{speed}` filled in. */
export function scriptedCreature(colour: string, speed: string): string {
  return `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "${colour}";
const SPEED = ${speed};

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;
}

/** `tidepool-swarm`: the `tidepool-auto` tree plus the four scripted creatures of 10.1. */
export function tidepoolSwarm(seed: SeedTree): SeedTree {
  const tree = new Map(seed);
  for (const [path, colour, speed] of SWARM_CREATURES) tree.set(path, scriptedCreature(colour, speed));
  return tree;
}

/** The three seeds of PL1, in the order they are named there. */
export function buildSeeds(seed: SeedTree = readSeed()): ReadonlyMap<string, SeedTree> {
  const automatic = withAutoPolicy(seed);
  return new Map([
    ["tidepool", seed],
    ["tidepool-auto", automatic],
    ["tidepool-swarm", tidepoolSwarm(automatic)],
  ]);
}

export function main(): void {
  const seeds = buildSeeds();
  const bundle = Object.fromEntries([...seeds].map(([name, tree]) => [name, Object.fromEntries(tree)]));
  mkdirSync(dirname(BUNDLE_FILE), { recursive: true });
  writeFileSync(BUNDLE_FILE, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`build:seeds: wrote ${[...seeds.keys()].join(", ")} to ${BUNDLE_FILE}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
