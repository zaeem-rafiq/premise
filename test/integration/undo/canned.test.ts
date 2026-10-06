// Slice 13, A21: the canned run of 02-tidepool 9.5 through the real engine.
// The simulator drives canned tools only; Agent resume is covered in real-agent.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { SwarmSim, tidepoolFiles, type AgentHandle } from "../collide/harness.ts";

const simulations: SwarmSim[] = [];
afterEach(() => {
  for (const sim of simulations.splice(0)) sim.db.close();
});

function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let n = 0; n < 60; n += 1) if (!sim.step(agent)) return;
  throw new Error("The canned agent did not park within 60 calls");
}

function land(sim: SwarmSim, agent: AgentHandle): void {
  for (let n = 0; n < 20; n += 1) {
    drive(sim, agent);
    sim.land();
    if (sim.state(agent) === "landed") return;
  }
  throw new Error("The canned agent did not land within 20 rounds");
}

/** The specification's canned starter substitutes are jellyfish and shrimp (02 9.5). */
function hero() {
  const sim = new SwarmSim(tidepoolFiles(), { seed: 7, synthetic: true });
  simulations.push(sim);
  const jellyfish = sim.open("hero-j");
  land(sim, jellyfish);
  const shrimp = sim.open("hero-h");
  land(sim, shrimp);
  const crab = sim.open("hero-c", { hold: true });
  drive(sim, crab);
  const shared = sim.open("hero-s");
  drive(sim, shared);
  expect(sim.cardOf(shared)?.kind).toBe("held");
  sim.tap(shared, "land");
  land(sim, shared);
  expect(sim.headsUps(crab).some((h) => h.items.some((item) => item.rule === "E2"))).toBe(true);
  sim.release(crab);
  land(sim, crab);
  expect(sim.trunk.pool.landings.map((l) => [l.seq, l.attempt_id])).toEqual([
    [1, jellyfish.id],
    [2, shrimp.id],
    [3, shared.id],
    [4, crab.id],
  ]);
  expect(sim.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
  expect(sim.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
  expect(sim.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 0.05)");
  return { sim, jellyfish, shrimp, crab, shared };
}

describe("Slice 13 canned hero Undo (02 9.5 A21, UN4 to UN8)", () => {
  it("A21 before the sweep: reverts R01 and crab, reopens crab, and preserves unrelated jellyfish", () => {
    const { sim, jellyfish, shrimp, crab, shared } = hero();
    const jellyfishFile = sim.files().get("creatures/jellyfish.js");
    expect(sim.trunk.undoPlan(3)).toEqual({
      ok: true,
      plan: { target_seq: 3, reverted: [3, 4], reopened: [crab.id], kept_readers: [], repairs: [] },
    });
    expect(sim.trunk.undo({ seq: 3, expect_reverted: [3, 4], request_id: "before-sweep" })).toEqual({
      ok: true,
      request_id: "before-sweep",
    });
    sim.land();
    expect(sim.trunk.pool.landings.map((l) => l.kind)).toEqual(["change", "change", "change", "change", "undo"]);
    expect(sim.note(5)?.undo).toMatchObject({ undoes: [3, 4], reopened: [crab.id], kept_readers: [] });
    expect(sim.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 100;");
    expect(sim.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(sim.files().has("creatures/crab.js")).toBe(false);
    expect(sim.files().get("creatures/jellyfish.js")).toBe(jellyfishFile);
    expect(sim.state(shared)).toBe("stopped");
    expect(sim.attempt(crab)).toMatchObject({ state: "going_around", revision: 2, resumes: 1 });
    expect(sim.state(jellyfish)).toBe("landed");
    expect(sim.state(shrimp)).toBe("landed");
    expect(sim.eventsOf("attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: crab.id, cause: "undo", revision: 2, model_changed: false }),
    ]);
  });

  it("A21 after the sweep: rejects the old plan, reverts four landings, and reopens three attempts", () => {
    const { sim, jellyfish, shrimp, crab } = hero();
    const sweep = sim.open("sweep-a");
    drive(sim, sweep);
    expect(sim.cardOf(sweep)?.kind).toBe("held");
    const squid = sim.open("sweep-b");
    land(sim, squid);
    drive(sim, sweep);
    expect(sim.cardOf(sweep)?.kind).toBe("held");
    sim.tap(sweep, "land");
    land(sim, sweep);
    expect(sim.trunk.pool.landings.slice(4).map((l) => [l.seq, l.attempt_id])).toEqual([
      [5, squid.id],
      [6, sweep.id],
    ]);
    const plan = {
      target_seq: 3,
      reverted: [3, 4, 5, 6],
      reopened: [crab.id, squid.id, sweep.id],
      kept_readers: [],
      repairs: [],
    };
    expect(sim.trunk.undoPlan(3)).toEqual({ ok: true, plan });
    expect(sim.trunk.undo({ seq: 3, expect_reverted: [3, 4], request_id: "old-plan" })).toEqual({
      ok: false,
      reason: "plan_changed",
      plan,
    });
    sim.land();
    expect(sim.trunk.pool.landings).toHaveLength(6);
    expect(sim.trunk.undo({ seq: 3, expect_reverted: [3, 4, 5, 6], request_id: "after-sweep" })).toEqual({
      ok: true,
      request_id: "after-sweep",
    });
    sim.land();
    expect(sim.note(7)?.undo).toMatchObject({
      undoes: [3, 4, 5, 6],
      reopened: [crab.id, squid.id, sweep.id],
      kept_readers: [],
    });
    expect(sim.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 100;");
    expect(sim.files().get("world/energy.js")).toContain("creature.energy - amount");
    expect(sim.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(sim.files().has("creatures/crab.js")).toBe(false);
    expect(sim.files().has("creatures/squid.js")).toBe(false);
    for (const agent of [crab, squid, sweep]) {
      expect(sim.attempt(agent)).toMatchObject({ state: "going_around", revision: 2, resumes: 1 });
    }
    expect(sim.eventsOf("attempt.reopened").map((e) => e.attempt_id)).toEqual([crab.id, squid.id, sweep.id]);
    for (const agent of [jellyfish, shrimp]) expect(sim.state(agent)).toBe("landed");
  });

  it("UN4 keeps a later energy reader whose creature does not reference energy", () => {
    const { sim, crab } = hero();
    const reader = sim.open("reader");
    land(sim, reader);
    expect(sim.landingOf(reader)?.seq).toBe(5);
    expect(sim.trunk.undoPlan(3)).toEqual({
      ok: true,
      plan: { target_seq: 3, reverted: [3, 4], reopened: [crab.id], kept_readers: [5], repairs: [] },
    });
    const before = new Map([...sim.landingOf(reader)!.files.keys()].map((path) => [path, sim.files().get(path)]));
    sim.trunk.undo({ seq: 3, expect_reverted: [3, 4], request_id: "keep-reader" });
    sim.land();
    expect(sim.state(reader)).toBe("landed");
    expect(sim.note(6)?.undo).toMatchObject({ kept_readers: [5] });
    for (const [path, contents] of before ?? []) expect(sim.files().get(path)).toBe(contents);
  });
});
