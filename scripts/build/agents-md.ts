// npm run agents-md
//
// Rewrites the lane table of AGENTS.md from scripts/ops/lanes.json. test/arch/lanes.test.ts fails when the
// two differ.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLanes } from "../ops/lanes.ts";
import { renderLaneTable, withLaneTable } from "./lane-table.ts";

const agentsFile = join(dirname(fileURLToPath(import.meta.url)), "../../AGENTS.md");

const before = readFileSync(agentsFile, "utf8");
const after = withLaneTable(before, renderLaneTable(loadLanes()));
if (after === before) {
  console.log("agents-md: the lane table of AGENTS.md is up to date.");
} else {
  writeFileSync(agentsFile, after);
  console.log("agents-md: the lane table of AGENTS.md was rewritten from scripts/ops/lanes.json.");
}
