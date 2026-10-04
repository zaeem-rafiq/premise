// Writes public/floor.json, the static settings of the Floor (03-floor 4.5), from src/config.
// Vite copies `public/` into `dist/client`, and the Vite dev server serves it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { floorJson } from "../../src/config/floor-json.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outFile = join(repoRoot, "public/floor.json");

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(floorJson(), null, 2) + "\n");
console.log("floor.json: written to public/floor.json");
