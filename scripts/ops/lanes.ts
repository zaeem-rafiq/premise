// The lanes of docs/spec/04-build-plan.md 3.1: who may write which path (BP2).
// The data is scripts/ops/lanes.json. `check:lane` and the lane table of AGENTS.md are built from it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The lane of every path that no other lane lists. */
export const LEAD = "lead";

export type Lane = { lane: string; paths: string[]; except: string[]; note?: string };

export type Lanes = {
  /** The branch that lane branches are compared with. */
  base: string;
  /** The paths the plan names for the lead. For the table only: the lead owns every unlisted path. */
  leadNamed: string[];
  lanes: Lane[];
};

const LANES_FILE = join(dirname(fileURLToPath(import.meta.url)), "lanes.json");

/** A glob of lanes.json: path characters, `*` and `**`. */
const GLOB = /^[A-Za-z0-9._~/*-]+$/;

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`lanes.json: ${where} must be an array of strings.`);
  }
  for (const glob of value) {
    if (!GLOB.test(glob) || glob.startsWith("/")) {
      throw new Error(`lanes.json: ${where} holds "${glob}", which is not a repository path glob.`);
    }
  }
  return value;
}

/** Reads and checks a lanes file. Throws on anything that is not the expected shape. */
export function parseLanes(json: string): Lanes {
  const data = JSON.parse(json) as { base?: unknown; lead?: { named?: unknown }; lanes?: unknown };
  if (typeof data.base !== "string" || data.base === "") {
    throw new Error("lanes.json: `base` must name a branch.");
  }
  if (!Array.isArray(data.lanes)) {
    throw new Error("lanes.json: `lanes` must be an array.");
  }
  const lanes = data.lanes.map((entry: { lane?: unknown; paths?: unknown; except?: unknown; note?: unknown }) => {
    if (typeof entry.lane !== "string" || !/^[a-z][a-z-]*$/.test(entry.lane) || entry.lane === LEAD) {
      throw new Error(`lanes.json: "${String(entry.lane)}" is not a lane name.`);
    }
    const lane: Lane = {
      lane: entry.lane,
      paths: stringArray(entry.paths, `${entry.lane}.paths`),
      except: stringArray(entry.except, `${entry.lane}.except`),
    };
    if (lane.paths.length === 0) {
      throw new Error(`lanes.json: lane ${lane.lane} lists no path.`);
    }
    if (typeof entry.note === "string") lane.note = entry.note;
    return lane;
  });
  const names = lanes.map((lane) => lane.lane);
  if (new Set(names).size !== names.length) {
    throw new Error("lanes.json: a lane is listed twice.");
  }
  return { base: data.base, leadNamed: stringArray(data.lead?.named, "lead.named"), lanes };
}

export function loadLanes(): Lanes {
  return parseLanes(readFileSync(LANES_FILE, "utf8"));
}

/** `**` matches any characters. `*` matches any characters except `/`. Everything else matches itself. */
export function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Every lane other than the lead that lists `path`. More than one is an error in lanes.json. */
export function listedBy(lanes: Lanes, path: string): string[] {
  return lanes.lanes
    .filter((lane) => matchesAny(path, lane.paths) && !matchesAny(path, lane.except))
    .map((lane) => lane.lane);
}

/** The one lane that owns `path`. Throws when two lanes list it. */
export function ownerOf(lanes: Lanes, path: string): string {
  const [first, second] = listedBy(lanes, path);
  if (second !== undefined) {
    throw new Error(`lanes.json: ${path} is listed by two lanes, ${first} and ${second}.`);
  }
  return first ?? LEAD;
}

export function laneNames(lanes: Lanes): string[] {
  return [LEAD, ...lanes.lanes.map((lane) => lane.lane)];
}

/** The paths among `paths` that `lane` does not own, each with its owner. */
export function outsideLane(
  lanes: Lanes,
  lane: string,
  paths: readonly string[],
): Array<{ path: string; owner: string }> {
  if (!laneNames(lanes).includes(lane)) {
    throw new Error(`"${lane}" is not a lane. Lanes: ${laneNames(lanes).join(", ")}.`);
  }
  return paths.map((path) => ({ path, owner: ownerOf(lanes, path) })).filter((entry) => entry.owner !== lane);
}
