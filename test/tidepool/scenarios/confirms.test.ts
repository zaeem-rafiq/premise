// Appendix A, row A22: the rule-based `confirm` items of 10.3's third table, each observed on
// seed `tidepool-swarm` through the real `Trunk` engine, and the `acknowledges with no edit`
// each canned pattern gives them. Every agent runs the registered pattern of `src/swarm` —
// `retune`, `reader`, `sweep-colour`, `edit-creature` and `sweep-search` included. The `n`
// overrides pin the draw positions the row needs (SW1): agent 0's first draw picks 2 of 4 —
// `retune` of `energy#REST_TICKS` — and agent 5's picks 0 of 4 — `edit-creature` of `s0000`.

import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { SwarmSim, swarmFiles, type AgentHandle } from "../../integration/collide/harness.ts";

function sim(): SwarmSim {
  return new SwarmSim(swarmFiles(), { seed: 7, synthetic: true, features_held: true });
}

/** Drive `agent` until it parks (a `wait` step, `stop`, or a terminal state). */
function drive(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 80; i += 1) {
    if (!s.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 80 calls");
}

/** Step + land alternately until the agent lands (bounded). */
function landNow(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    drive(s, agent);
    s.land();
    if (s.state(agent) === "landed") return;
  }
  throw new Error("landNow: the agent did not land");
}

function judgmentsOf(s: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return [...s.trunk.pool.judgments.values()].filter((j) => j.attempt_id === agent.id);
}

const itemKeys = (hu: HeadsUp): string[] => hu.items.map((i) => `${i.rule}:${i.premise.key}`);

// --- A22's scenarios, on seed `tidepool-swarm`, over the registered patterns -----------------

describe("10.3 rule-based confirms (A22)", () => {
  it(
    "`retune` of REST_TICKS lands while `rescale-energy` is in flight: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      drive(s, rescale); // has read ENERGY_MAX and replaced it; its `refs:` premise stands
      const retune = s.open("retune", { n: 0 }); // agent 0's draw picks `energy#REST_TICKS`
      landNow(s, retune);

      const hus = s.headsUps(rescale);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:world/energy.js#REST_TICKS", "QR1m:refs:world/energy.js#ENERGY_MAX"]);
      // The pattern acknowledges with no edit: release, land, and its landing is exactly its own
      // change (no extra repair paths beyond what its `replace` + relied_on_by fixes wrote).
      s.release(rescale);
      landNow(s, rescale);
      expect(s.landingOf(rescale)).toBeDefined();
      expect([...s.landingOf(rescale)!.files.keys()]).toContain("world/energy.js");
    },
  );

  it("`rescale-energy` lands while `cosmetic` is in flight: E2m `confirm`, F3m folded", { timeout: 30_000 }, () => {
    const s = sim();
    const cosmetic = s.open("cosmetic", { hold: true });
    drive(s, cosmetic); // has read world/energy.js and reworded its comment
    const rescale = s.open("rescale-energy");
    landNow(s, rescale);

    const hus = s.headsUps(cosmetic);
    expect(hus).toHaveLength(1);
    expect(hus[0]!.result).toBe("confirm");
    // One item: the F3m judgment on the file is folded into the E2m (HU2a).
    expect(itemKeys(hus[0]!)).toEqual(["E2m:world/energy.js#ENERGY_MAX"]);
    expect(judgmentsOf(s, cosmetic)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "E2m", kind: "entity", key: "world/energy.js#ENERGY_MAX", result: "confirm" }),
        expect.objectContaining({ rule: "F3m", kind: "file", key: "world/energy.js", result: "confirm" }),
      ]),
    );
    s.release(cosmetic);
    landNow(s, cosmetic);
  });

  it(
    "`cosmetic` lands while `rescale-energy`, `add-energy` and `reader` are in flight: F2 `holds` for `reader`, no heads-up to anyone",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      const addEnergy = s.open("add-energy", { hold: true });
      const reader = s.open("reader", { hold: true });
      drive(s, rescale);
      drive(s, addEnergy);
      drive(s, reader);

      const cosmetic = s.open("cosmetic");
      landNow(s, cosmetic);

      for (const a of [rescale, addEnergy, reader]) expect(s.headsUps(a)).toHaveLength(0);
      expect(judgmentsOf(s, reader)).toEqual([
        expect.objectContaining({ rule: "F2", kind: "file", key: "world/energy.js", result: "holds" }),
      ]);
      expect(judgmentsOf(s, rescale)).toHaveLength(0);
      expect(judgmentsOf(s, addEnergy)).toHaveLength(0);
    },
  );

  it(
    "`sweep-colour` lands while `edit-creature` of the same file is in flight: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const edit = s.open("edit-creature", { hold: true, n: 5 }); // agent 5's draw picks `s0000`
      drive(s, edit); // has replaced `const SPEED = 1;` with `1.5`
      const sweep = s.open("sweep-colour");
      landNow(s, sweep);

      const hus = s.headsUps(edit);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:creatures/s0000.js#BODY", "QR1m:refs:creatures/s0000.js#SPEED"]);
      s.release(edit);
      landNow(s, edit);
    },
  );

  it(
    "`edit-creature` lands while `sweep-colour` holds an edit of that file: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const sweep = s.open("sweep-colour", { hold: true });
      drive(s, sweep); // has replaced the BODY of s0000.js (among its first four)
      const edit = s.open("edit-creature", { n: 5 }); // agent 5's draw picks `s0000`
      landNow(s, edit);

      const hus = s.headsUps(sweep);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:creatures/s0000.js#SPEED", "QR1m:refs:creatures/s0000.js#BODY"]);
      s.release(sweep);
      landNow(s, sweep);
    },
  );

  // 02-tidepool.md 10.3: "a `reader` | `rescale-energy` in flight | `refs:…#ENERGY_MAX` | QR4,
  // scripted `holds`". TR8 (01-core.md): for QR4 "the input's `truth` is the landed change's list"
  // — the reader's `[bounce, step, wander]` does not name the query, so the scripted answer is
  // `holds`. The engine answers `repair` (`triage_depends`, p = 1) with a `repair` heads-up:
  // `applyClassification` falls back to the RECEIVER's truth because `causeAttempt` is only set
  // when the classification holds an E1 item (src/core/trunk/tick.ts, the E1 loop before
  // `applyClassification`), so QR4's decider is never the landed change without an E1.
  it.fails(
    "a `reader` lands while `rescale-energy` is in flight: QR4 triage, answered `holds`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      drive(s, rescale);
      const reader = s.open("reader");
      landNow(s, reader);

      expect(
        judgmentsOf(s, rescale).some(
          (j) =>
            j.rule === "QR4" &&
            j.klass === "triage" &&
            j.result === "holds" &&
            j.key === "refs:world/energy.js#ENERGY_MAX",
        ),
      ).toBe(true);
      // A triage answer of `holds` arrives as an `info` heads-up (HU2a).
      const hus = s.headsUps(rescale);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("info");
    },
  );

  it(
    "a T-plain file lands while `sweep-search` has altered three containers: QT1 `repair`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const sweep = s.open("sweep-search", { hold: true });
      drive(s, sweep); // its three replaces on the first containers stand
      const add = s.open("add-plain");
      landNow(s, add);
      const added = [...s.landingOf(add)!.files.keys()][0]!;

      const hus = s.headsUps(sweep);
      expect(hus).toHaveLength(1);
      const hu = hus[0]!;
      expect(hu.result).toBe("repair");
      const qt1 = hu.items.find((i) => i.rule === "QT1")!;
      expect(qt1.reason).toBe("sweep_incomplete");
      expect(qt1.diff.kind).toBe("query");
      if (qt1.diff.kind === "query") {
        expect(qt1.diff.added.map((x) => x.key)).toContain(`${added}#update`);
      }
      // The pattern repairs the gained container with the same edit, then lands.
      s.release(sweep);
      landNow(s, sweep);
      expect(s.files().get(added)).toContain("wander(creature, 0.1)");
    },
  );

  it(
    "a `retune` of REST_TICKS lands while another `retune` of it is in flight: E1 with a QR1m item in the same heads-up",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const a = s.open("retune", { hold: true, n: 0 }); // agent 0's draw picks REST_TICKS
      drive(s, a); // its `replace` 300 -> 240 is recorded
      const b = s.open("retune", { n: 0 }); // the same stream position draws the same constant
      landNow(s, b);

      const hus = s.headsUps(a);
      expect(hus).toHaveLength(1);
      const hu = hus[0]!;
      expect(hu.result).toBe("repair");
      expect(itemKeys(hu)).toEqual(["E1:world/energy.js#REST_TICKS", "QR1m:refs:world/energy.js#REST_TICKS"]);
      expect(hu.dropped_ops.length).toBe(1);
      // Its row's answer: read again, replace from the new current value (240 -> 360), land.
      s.release(a);
      landNow(s, a);
      expect(s.files().get("world/energy.js")).toContain("export const REST_TICKS = 360;");
    },
  );
});
