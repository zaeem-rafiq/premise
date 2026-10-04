// `whoRelies`, `whoPickList` and `whoKinds` (01-core 11.6, 03-floor 3.11, CO23b).
// Expected values are worked by hand from the hero-c04 / hero-c05 streams (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import type { FloorState } from "./state.ts";
import { emptyFloorState } from "./state.ts";
import { reduce } from "./reduce.ts";
import { premiseMatches, whoKinds, whoPickList, whoRelies } from "./who-relies.ts";

const STREAMS = join(__dirname, "../../../test/fixtures/streams");
const ENERGY = "world/energy.js#ENERGY_MAX";

function replayFile(name: string): FloorState {
  const lines = readFileSync(join(STREAMS, name), "utf8").split("\n").filter((line) => line !== "");
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  const state = emptyFloorState();
  for (const event of events) reduce(state, event);
  return state;
}

function replayPrefix(name: string, k: number): FloorState {
  const lines = readFileSync(join(STREAMS, name), "utf8").split("\n").filter((line) => line !== "");
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  const state = emptyFloorState();
  for (const event of events.slice(0, k)) reduce(state, event);
  return state;
}

describe("premiseMatches (01-core 11.6)", () => {
  const target = { kind: "entity" as const, key: ENERGY };
  it("entity K: the entity premise itself or a file premise on its path", () => {
    expect(premiseMatches({ kind: "entity", key: ENERGY }, target)).toBe(true);
    expect(premiseMatches({ kind: "file", key: "world/energy.js" }, target)).toBe(true);
    expect(premiseMatches({ kind: "entity", key: "world/energy.js#SPEED" }, target)).toBe(false);
    expect(premiseMatches({ kind: "file", key: "world/other.js" }, target)).toBe(false);
    expect(premiseMatches({ kind: "query", key: `refs:${ENERGY}` }, target)).toBe(false);
  });
  it("file F: the file premise or an entity premise on one of its entities", () => {
    const file = { kind: "file" as const, key: "world/energy.js" };
    expect(premiseMatches({ kind: "file", key: "world/energy.js" }, file)).toBe(true);
    expect(premiseMatches({ kind: "entity", key: ENERGY }, file)).toBe(true);
    expect(premiseMatches({ kind: "file", key: "world/movement.js" }, file)).toBe(false);
  });
});

describe("whoRelies, hero-c04", () => {
  const state = replayFile("hero-c04.ndjson");

  it("landed rows newest first: the crab landing (2) then the energy landing (1)", () => {
    const result = whoRelies(state, { kind: "entity", key: ENERGY });
    expect(result.summaryOnly).toBe(false);
    expect(result.windowed).toBe(false);
    expect(result.inFlight).toEqual([]);
    expect(result.landed.map((row) => row.seq)).toEqual([2, 1]);
    expect(result.landed[0]?.matched).toEqual({ kind: "entity", key: ENERGY });
  });

  it("before the crab landing, the crab attempt is in flight on ENERGY_MAX", () => {
    // Event index 30 is headsup.sent to a_A; seq 1 is landed, a_A is going around.
    const prefix = replayPrefix("hero-c04.ndjson", 31);
    const result = whoRelies(prefix, { kind: "entity", key: ENERGY });
    expect(result.inFlight.map((row) => row.attempt.id)).toEqual(["a_A"]);
    expect(result.inFlight[0]?.matched.key).toBe(ENERGY);
    expect(result.inFlight[0]?.matched.read).toBe(true);
    expect(result.inFlight[0]?.matched.derived).toBe(true);
    expect(result.landed.map((row) => row.seq)).toEqual([1]);
  });

  it("file target matches entity premises on its path", () => {
    const result = whoRelies(state, { kind: "file", key: "world/energy.js" });
    expect(result.landed.map((row) => row.seq)).toEqual([2, 1]);
  });

  it("a creature file matches only the landing that touched it", () => {
    const result = whoRelies(state, { kind: "file", key: "creatures/crab.js" });
    expect(result.landed.map((row) => row.seq)).toEqual([2]);
  });

  it("undone landings leave the list", () => {
    const entry = state.landings[2];
    if (entry === undefined) throw new Error("landing 2 missing");
    entry.undone_by = 3;
    const result = whoRelies(state, { kind: "entity", key: ENERGY });
    expect(result.landed.map((row) => row.seq)).toEqual([1]);
  });
});

describe("whoRelies, hero-c05", () => {
  it("mid-stream: the energy attempt is in flight while the crab landing is landed", () => {
    // Event index 30 makes a_S go around on the refs query of ENERGY_MAX.
    const prefix = replayPrefix("hero-c05.ndjson", 31);
    const result = whoRelies(prefix, { kind: "entity", key: ENERGY });
    expect(result.inFlight.map((row) => row.attempt.id)).toEqual(["a_S"]);
    expect(result.landed.map((row) => row.seq)).toEqual([1]);
  });
});

describe("whoPickList (3.11: every entity key of the path, then the file)", () => {
  it("creatures/crab.js knows the keys its writes named", () => {
    const state = replayFile("hero-c04.ndjson");
    expect(whoPickList(state, "creatures/crab.js")).toEqual([
      { kind: "entity", key: "creatures/crab.js#(import ../world/energy.js)" },
      { kind: "entity", key: "creatures/crab.js#spawn" },
      { kind: "entity", key: "creatures/crab.js#update" },
      { kind: "file", key: "creatures/crab.js" },
    ]);
  });
  it("an unknown file lists only itself", () => {
    const state = replayFile("hero-c04.ndjson");
    expect(whoPickList(state, "creatures/snail.js")).toEqual([{ kind: "file", key: "creatures/snail.js" }]);
  });
});

describe("whoKinds (CO23b)", () => {
  it("the creature files of the listed rows, plus the target's own kind", () => {
    const state = replayFile("hero-c04.ndjson");
    const result = whoRelies(state, { kind: "entity", key: ENERGY });
    // Landing 2 wrote creatures/crab.js; landing 1 only world/energy.js.
    expect(whoKinds(state, { kind: "entity", key: ENERGY }, result)).toEqual(["crab"]);
  });
});
