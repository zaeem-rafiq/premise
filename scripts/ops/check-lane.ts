// npm run check:lane -- <lane> <branch>
//
// Fails if the branch changes a path outside the lane's paths in scripts/ops/lanes.json (BP2).
// Exit 0: every changed path is inside the lane. Exit 1: at least one is outside. Exit 2: the check could not run.
//
// Git runs in the current directory. Renames are listed as a removal and an addition, so moving another
// lane's file is seen as a change to that lane's path.

import { execFileSync } from "node:child_process";
import { loadLanes, outsideLane } from "./lanes.ts";

const EXIT_OUTSIDE = 1;
const EXIT_CANNOT_RUN = 2;

function changedPaths(base: string, branch: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${branch}`, "--"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter((path) => path !== "");
}

function main(): number {
  const [lane, branch, ...rest] = process.argv.slice(2);
  if (lane === undefined || branch === undefined || rest.length > 0) {
    console.error("Usage: npm run check:lane -- <lane> <branch>");
    return EXIT_CANNOT_RUN;
  }
  if (branch.startsWith("-")) {
    console.error(`check:lane: "${branch}" is not a branch name.`);
    return EXIT_CANNOT_RUN;
  }

  const lanes = loadLanes();
  let paths: string[];
  let outside: Array<{ path: string; owner: string }>;
  try {
    paths = changedPaths(lanes.base, branch);
    outside = outsideLane(lanes, lane, paths);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : (error as Error).message;
    console.error(`check:lane: ${detail}`);
    return EXIT_CANNOT_RUN;
  }

  if (outside.length > 0) {
    console.error(`check:lane: ${branch} changes ${outside.length} path(s) outside the lane "${lane}":`);
    for (const entry of outside) {
      console.error(`  ${entry.path}  (lane: ${entry.owner})`);
    }
    return EXIT_OUTSIDE;
  }
  console.log(
    `check:lane: ${branch} changes ${paths.length} path(s) against ${lanes.base}, all inside the lane "${lane}".`,
  );
  return 0;
}

process.exitCode = main();
