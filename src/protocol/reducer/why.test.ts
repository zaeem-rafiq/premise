// `whyCard` and `whyTarget` (03-floor 3.9, 4.4). Expected values are worked by
// hand from the hero-c04 / hero-c05 streams and the rules of 01-core (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import type { FloorState } from "./state.ts";
import { emptyFloorState } from "./state.ts";
import { reduce } from "./reduce.ts";
import { whyCard, whyTarget } from "./why.ts";

const STREAMS = join(__dirname, "../../../test/fixtures/streams");

function replayFile(name: string): FloorState {
  const lines = readFileSync(join(STREAMS, name), "utf8").split("\n").filter((line) => line !== "");
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  const state = emptyFloorState();
  for (const event of events) reduce(state, event);
  return state;
}

/** Replay only the first `k` events of a fixture. */
function replayPrefix(name: string, k: number): FloorState {
  const lines = readFileSync(join(STREAMS, name), "utf8").split("\n").filter((line) => line !== "");
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  const state = emptyFloorState();
  for (const event of events.slice(0, k)) reduce(state, event);
  return state;
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a defined value");
  return value;
}

describe("whyTarget (03-floor 4.4)", () => {
  it("hero-c04: names the newest landing that wrote the path", () => {
    const state = replayFile("hero-c04.ndjson");
    expect(whyTarget(state, "world/energy.js")).toBe(1);
    expect(whyTarget(state, "creatures/crab.js")).toBe(2);
    expect(whyTarget(state, "creatures/snail.js")).toBeNull();
  });
  it("hero-c05: the energy landing also wrote creatures/crab.js, so it wins", () => {
    const state = replayFile("hero-c05.ndjson");
    expect(whyTarget(state, "creatures/crab.js")).toBe(2);
    expect(whyTarget(state, "world/energy.js")).toBe(2);
  });
});

describe("whyCard, hero-c04", () => {
  const state = replayFile("hero-c04.ndjson");

  it("landing 2: requester, intent, agent, premises, go-around, checks, how it landed, git ids", () => {
    const card = whyCard(state, 2);
    expect(card.status).toBe("live");
    expect(card.kind).toBe("change");
    expect(card.requester).toBe("owner");
    expect(card.intentText).toBe("a crab that hides when its energy is low");
    expect(card.agent).toBe("real");
    expect(card.model).toBe("model-a");
    // Frozen lights: the entity read+derived, the file edit.
    const keys = card.premises.map((p) => `${p.kind}:${p.key}`).sort();
    expect(keys).toEqual(["entity:world/energy.js#ENERGY_MAX", "file:creatures/crab.js"]);
    const energy = must(card.premises.find((p) => p.key === "world/energy.js#ENERGY_MAX"));
    expect(energy.read).toBe(true);
    expect(energy.derived).toBe(true);
    expect(energy.edit).toBe(false);
    expect(energy.light).toBe("holds");
    // The go-around: cause landing 1, rule E2, the agent's statement.
    expect(card.under.length).toBe(1);
    const under = must(card.under[0]);
    expect(under.result).toBe("repair");
    expect(under.n).toBe(1);
    expect(under.causeType).toBe("landing");
    expect(under.causeSeq).toBe(1);
    expect(under.causeIntent).toBe("make energy a fraction from 0 to 1");
    expect(under.statement).toBe("Energy is now a fraction from 0 to 1, so the hide threshold is 0.3.");
    expect(under.items).toEqual([
      {
        kind: "entity",
        key: "world/energy.js#ENERGY_MAX",
        rule: "E2",
        reason: "ENERGY_MAX is now 1, a fraction scale",
        causeSeq: 1,
        scripted: false,
        added: [],
      },
    ]);
    expect(card.checks).toEqual([]);
    expect(card.landedHow).toEqual({ id: "why.landed.auto", ts: null, n: 1 });
    expect(card.paths).toEqual(["creatures/crab.js"]);
    expect(card.commit).toBe("c044bbbb04c04c04c04c04c04c04c04c04c04c04");
    expect(card.tree).toBe("tree-2");
    expect(card.parentCommit).toBe("c044aaaa04c04c04c04c04c04c04c04c04c04c04");
    expect(card.changeId).toBe("c-a_A");
    expect(card.intentId).toBe("i_A");
    expect(card.attemptId).toBe("a_A");
    expect(card.undone).toBe(false);
    expect(card.partial).toBe(false);
    expect(card.needsNote).toBe(false);
    expect(card.note).not.toBeNull();
  });

  it("landing 1: no go-arounds, parent null (first landed commit)", () => {
    const card = whyCard(state, 1);
    expect(card.intentText).toBe("make energy a fraction from 0 to 1");
    expect(card.under).toEqual([]);
    expect(card.commit).toBe("c044aaaa04c04c04c04c04c04c04c04c04c04c04");
    expect(card.parentCommit).toBeNull();
    // Frozen premises: the entity edit and the derived refs query.
    const keys = card.premises.map((p) => `${p.kind}:${p.key}`).sort();
    expect(keys).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "query:refs:world/energy.js#ENERGY_MAX",
    ]);
  });

  it("seq 0 and unknown seqs show the seed state", () => {
    expect(whyCard(state, 0).status).toBe("seed");
    expect(whyCard(state, 99).status).toBe("seed");
  });

  it("an accepted, not yet landed landing shows why.landing only (FL3)", () => {
    // Event 26 (index 25) is landing.accepted of seq 1; landing.landed is index 30.
    const prefix = replayPrefix("hero-c04.ndjson", 27);
    const card = whyCard(prefix, 1);
    expect(card.status).toBe("landing");
    expect(card.commit).toBeNull();
  });
});

describe("whyCard, hero-c05", () => {
  const state = replayFile("hero-c05.ndjson");

  it("landing 2 carries both writes and the go-around statement", () => {
    const card = whyCard(state, 2);
    expect(card.intentText).toBe("make energy a fraction from 0 to 1");
    expect(card.paths).toEqual(["world/energy.js", "creatures/crab.js"]);
    expect(card.writes.map((w) => w.key)).toEqual([
      "world/energy.js#ENERGY_MAX",
      "creatures/crab.js#update",
    ]);
    expect(card.under.length).toBe(1);
    const under = must(card.under[0]);
    expect(under.items[0]?.kind).toBe("query");
    expect(under.items[0]?.key).toBe("refs:world/energy.js#ENERGY_MAX");
    expect(under.items[0]?.rule).toBe("QR1");
    expect(under.items[0]?.reason).toBe("new referrers of ENERGY_MAX: creatures/crab.js");
    expect(under.statement).toBe("The new crab compared energy with 30; changed it to 0.3 in the same change.");
  });
});

describe("whyCard states", () => {
  it("unwitnessed: the commit lines plus why.unwitnessed", () => {
    const state = replayFile("hero-c04.ndjson");
    // Re-announce the pool state with seq 1 unwitnessed (01-core 3.6).
    const lines = readFileSync(join(STREAMS, "hero-c04.ndjson"), "utf8").split("\n").filter((l) => l !== "");
    const poolState = JSON.parse(lines[1] ?? "") as PoolEvent;
    const reannounced = { ...poolState, unwitnessed: [1] } as PoolEvent;
    reduce(state, reannounced);
    const card = whyCard(state, 1);
    expect(card.status).toBe("unwitnessed");
    expect(card.commit).toBe("c044aaaa04c04c04c04c04c04c04c04c04c04c04");
  });
});
