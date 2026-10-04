// The second catch of 02-tidepool.md section 8 and the P9 pair of 9.5, played by the canned
// casts of 10.5 through the real `Trunk` engine (Appendix A rows A13 to A16, A17, A20).
// Expected values come from sections 8 and 9.5 and Appendix A, never from the implementation
// (BP1). The plain-merge pool is not built in this lane: where a row's expectation is a
// `plain` tree, the test names it but does not assert on it.

import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { SwarmSim, tidepoolFiles, type AgentHandle } from "../../integration/collide/harness.ts";

function sim(): SwarmSim {
  return new SwarmSim(tidepoolFiles(), { seed: 7, synthetic: true, features_held: true });
}

/** Drive `agent` until it parks (a `wait` step, `stop`, or a terminal state). */
function drive(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 60; i += 1) {
    if (!s.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 60 calls");
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

const rulesOf = (h: HeadsUp): string[] => h.items.map((i) => i.rule);

describe("the second catch: a listing gains a match (8.3, 8.4; A13, A14, A16)", () => {
  it("order 1 (8.3): L1 repair catches the seahorse; every creature ends gold", { timeout: 30_000 }, () => {
    const s = sim();
    const a = s.open("gold-a", { hold: true });
    drive(s, a); // list, five reads, nine replaces — parks before `submit`
    expect(s.cardOf(a)).toBeUndefined();
    const b = s.open("gold-b");
    landNow(s, b);
    expect(s.state(b)).toBe("landed");

    // Step 3: one `repair` heads-up for A — the L1 item (`listing`, `sweep_incomplete`,
    // `added: ["seahorse.js"]`) and the two QR4 items on fish.js's constants, answered
    // `holds` inside the transaction (TR8: fish.js is not in B's truth list).
    const hus = s.headsUps(a);
    expect(hus).toHaveLength(1);
    const hu = hus[0]!;
    expect(hu.result).toBe("repair");
    expect(rulesOf(hu)).toEqual(["L1", "QR4", "QR4"]);
    const l1 = hu.items[0]!;
    expect(l1.premise).toEqual({ kind: "listing", key: "creatures/" });
    expect(l1.reason).toBe("sweep_incomplete");
    expect(l1.diff).toEqual({ kind: "listing", added: ["seahorse.js"], removed: [] });
    expect(hu.go_around).toBe(1);
    expect(s.attempt(a)?.go_arounds).toBe(1);

    // Step 4: A reads the seahorse, repaints it, submits — still held, so release it.
    drive(s, a);
    s.release(a);
    landNow(s, a);
    expect(s.state(a)).toBe("landed");
    const resolved = s.eventsOf("headsup.resolved").find((e) => e.attempt_id === a.id);
    expect(resolved?.statement).toBe("A seahorse arrived during the repaint. Painted it gold too.");

    // Step 5: every creature is gold, the seahorse included (8.3's end state).
    const files = s.files();
    for (const name of ["anemone", "fish", "minnow", "snail", "turtle", "seahorse"]) {
      const src = files.get(`creatures/${name}.js`);
      expect(src).toBeDefined();
      expect(src).not.toMatch(/"(pink|purple|orange|yellow|silver|brown|sand|green|teal)"/);
      expect(src).toMatch(/"gold"/);
    }
    expect(files.get("creatures/seahorse.js")).toContain('const BODY = "gold";');
  });

  it("order 2 (8.4): the repaint lands first; the seahorse hears an info and needs no edit", { timeout: 30_000 }, () => {
    const s = sim();
    const a = s.open("gold-a");
    const b = s.open("gold-b", { hold: true });
    drive(s, b); // B has read fish.js and written seahorse.js (F4 row of 8.4)
    landNow(s, a);
    expect(s.state(a)).toBe("landed");

    // B receives an `info` heads-up — its `file:creatures/fish.js` premise judged by F4,
    // answered `holds` under scripted triage — and no go-around, no repair.
    const hus = s.headsUps(b);
    expect(hus).toHaveLength(1);
    expect(hus[0]!.result).toBe("info");
    expect(s.attempt(b)?.go_arounds).toBe(0);

    s.release(b);
    landNow(s, b);
    expect(s.state(b)).toBe("landed");
    // B is not forced to be gold (8.4): the seahorse lands pink.
    expect(s.files().get("creatures/seahorse.js")).toContain('const BODY = "pink";');
    expect(s.files().get("creatures/fish.js")).toContain('const BODY = "gold";');
  });
});

describe("the same catch through a search (8.6; A15)", () => {
  it("QT1 repair: the ray that lands mid-sweep is changed without a read", { timeout: 30_000 }, () => {
    const s = sim();
    const a = s.open("wrap-a", { hold: true });
    drive(s, a); // search + the two replaces on fish.js
    const b = s.open("wrap-b");
    landNow(s, b);

    const hus = s.headsUps(a);
    expect(hus).toHaveLength(1);
    const hu = hus[0]!;
    expect(hu.result).toBe("repair");
    expect(rulesOf(hu)).toContain("QT1");
    const qt1 = hu.items.find((i) => i.rule === "QT1")!;
    expect(qt1.reason).toBe("sweep_incomplete");
    expect(qt1.diff.kind).toBe("query");
    if (qt1.diff.kind === "query") {
      expect(qt1.diff.added.map((x) => x.key)).toContain("creatures/ray.js#update");
    }

    s.release(a);
    landNow(s, a);
    expect(s.state(a)).toBe("landed");
    const ray = s.files().get("creatures/ray.js")!;
    expect(ray).toContain("bounce(ray);");
    expect(ray).toContain('import { bounce } from "../world/bounds.js";');
    expect(ray).not.toContain("wrap(ray)");
    const fish = s.files().get("creatures/fish.js")!;
    expect(fish).toContain("bounce(fish);");
    expect(fish).not.toContain("wrap(fish)");
  });
});
