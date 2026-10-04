// The P9 pair of 02-tidepool.md 9.5 (Appendix A rows A17, A20): the sweep `sweep-a` rewrites
// `drain` to percent and every caller it searched out; the late creature `sweep-b` lands while
// the sweep is held and is caught by QT1 + QR1 in one heads-up. The world the pair runs in is
// the one of 9.5's beat 4: the starter shrimp landed, and R01 (`hero-s`) already made energy a
// fraction and fixed the shrimp in the same change.

import { describe, expect, it } from "vitest";
import { SwarmSim, tidepoolFiles, type AgentHandle } from "../../integration/collide/harness.ts";

function sim(): SwarmSim {
  return new SwarmSim(tidepoolFiles(), { seed: 7, synthetic: true, features_held: true });
}

function drive(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 60; i += 1) {
    if (!s.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 60 calls");
}

function landNow(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    drive(s, agent);
    s.land();
    if (s.state(agent) === "landed") return;
  }
  throw new Error("landNow: the agent did not land");
}

/** Beat 1–3 of 9.5: the starter shrimp lands, then `hero-s` lands the fraction change and
 * rewrites `drain(shrimp, 5)` to `drain(shrimp, 0.05)` in the same change (D2, guide rule 8). */
function beat1to3(s: SwarmSim): void {
  const shrimp = s.open("hero-h");
  landNow(s, shrimp);
  const r01 = s.open("hero-s");
  drive(s, r01); // reads, the replace, the relied_on_by visits — parks at the held card
  s.tap(r01, "land");
  landNow(s, r01);
  expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
  expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 0.05)");
}

describe("P9: the sweep and the late creature (9.5, A20)", () => {
  it("QT1 + QR1 in one heads-up; the stale card does nothing; the squid ends at drain 10", () => {
    const s = sim();
    beat1to3(s);

    // Beat 5: the sweep searches `drain(`, changes `drain`, `liveOneTick` and the shrimp's
    // call, and waits on its held card.
    const a = s.open("sweep-a");
    drive(s, a);
    expect(s.state(a)).toBe("held");
    const firstCard = s.cardOf(a);
    expect(firstCard?.kind).toBe("held");
    // The blast radius is empty: nothing in flight depends on what the sweep alters.
    expect((firstCard?.blast_radius as Record<string, { repair: string[] }>)[a.id]?.repair).toEqual([]);

    const b = s.open("sweep-b");
    landNow(s, b);
    expect(s.state(b)).toBe("landed");

    // One `repair` heads-up for the sweep: QT1 on `text:creatures/:drain(` (the gained
    // `creatures/squid.js#update`) and QR1 on `refs:world/energy.js#drain`.
    const hus = s.headsUps(a);
    expect(hus).toHaveLength(1);
    const hu = hus[0]!;
    expect(hu.result).toBe("repair");
    const rules = hu.items.map((i) => `${i.rule}:${i.premise.key}`);
    expect(rules).toEqual(["QT1:text:creatures/:drain(", "QR1:refs:world/energy.js#drain"]);
    const qt1 = hu.items[0]!;
    expect(qt1.diff.kind).toBe("query");
    if (qt1.diff.kind === "query") {
      const keys = qt1.diff.added.map((x) => x.key);
      expect(keys).toContain("creatures/squid.js#update");
      const squid = qt1.diff.added.find((x) => x.key === "creatures/squid.js#update")!;
      expect(squid.source).toContain("drain(squid, 0.1)");
    }

    // The held card closed as `stale`; a tap on it changes nothing (T8).
    expect(s.eventsOf("card.closed").some((e) => e.action === "stale" && e.card_id === firstCard?.card_id)).toBe(true);
    s.tap(a, "land");
    expect(s.state(a)).not.toBe("landed");

    // P9a rewrites the squid's number from the item's source, with no read, and submits;
    // a new held card opens and the second tap lands it.
    drive(s, a);
    const secondCard = s.cardOf(a);
    expect(secondCard?.kind).toBe("held");
    expect(secondCard?.card_id).not.toBe(firstCard?.card_id);
    s.tap(a, "land");
    landNow(s, a);
    expect(s.state(a)).toBe("landed");

    // A17's `main`: `drain` takes percent; the shrimp drains 5; the squid drains 10.
    const energy = s.files().get("world/energy.js")!;
    expect(energy).toContain("creature.energy - (percent / 100) * ENERGY_MAX");
    expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(s.files().get("creatures/squid.js")).toContain("drain(squid, 10)");
  });

  it("other order (A20): the sweep lands first; E2 on `drain` sends the squid around", () => {
    const s = sim();
    beat1to3(s);

    // P9b is in flight — it has listed, read GUIDE.md and read its entities — when the
    // sweep lands; the E2 on `entity:world/energy.js#drain` then reaches it mid-script.
    const b = s.open("sweep-b", { hold: true });
    drive(s, b);
    const a = s.open("sweep-a");
    drive(s, a);
    s.tap(a, "land");
    landNow(s, a);
    expect(s.state(a)).toBe("landed");

    const hus = s.headsUps(b);
    const e2 = hus.find((h) => h.items.some((i) => i.rule === "E2" && i.premise.key === "world/energy.js#drain"));
    expect(e2).toBeDefined();
    expect(e2!.result).toBe("repair");
    s.release(b);
    landNow(s, b);
    expect(s.state(b)).toBe("landed");
    expect(s.files().get("creatures/squid.js")).toContain("drain(squid, 10)");
  });
});
