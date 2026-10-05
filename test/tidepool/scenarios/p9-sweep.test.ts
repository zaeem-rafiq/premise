// The P9 pair of 02-tidepool.md 9.5 in the full run of row A20 (beats 1 to 5): the starter
// shrimp lands, the crab is in flight when R01 lands (held before its submit, like the demo's
// race-card wait), R01 lands the fraction change and rewrites the landed shrimp in the same
// change, the crab gets E2, repairs `30` to `0.3` and lands, and the P9 pair plays in both
// orders on top of that world. A17/A18/A19 are the self-test verdicts of the trees this
// produces; A21 is the undo of R01, before and after the sweep; the last test is A20's B1
// variant of P9a.

import { describe, expect, it } from "vitest";
import { SwarmSim, tidepoolFiles, type AgentHandle } from "../../integration/collide/harness.ts";
import { sweepACast } from "../../../src/swarm/casts/sweep-a.ts";
import { cannedCast } from "../../../src/swarm/casts/runner.ts";
import { crabStatsOf, verdictOf } from "./eval.ts";
import { specBlock } from "../spec.ts";

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

/** The seeded generator of HO2, taken from the specification text and built by evaluating it. */
function makeReseed(): (n: number) => void {
  const source = specBlock("replace `Math.random` with the generator below", "```js");
  const build = new Function(`${source}\nreturn mulberry32;`) as () => (seed: number) => () => number;
  const mulberry32 = build();
  return (n: number): void => {
    Math.random = mulberry32(n);
  };
}

/** The judgments an attempt carries, newest last. */
function judgmentsOf(s: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return [...s.trunk.pool.judgments.values()].filter((j) => j.attempt_id === agent.id);
}

/** The `submit.result` statuses an attempt was answered, in order. */
function submitResults(s: SwarmSim, agent: AgentHandle): string[] {
  return s
    .eventsOf("submit.result")
    .filter((e) => e.attempt_id === agent.id)
    .map((e) => String(e.status));
}

/** The landing order of the named attempts (`landing.accepted` seq order). */
function landingOrder(s: SwarmSim, agents: AgentHandle[]): string[] {
  const wanted = new Set(agents.map((a) => a.id));
  return s
    .eventsOf("landing.accepted")
    .filter((e) => e.kind === "change")
    .map((e) => e.attempt_id)
    .filter((id): id is string => typeof id === "string" && wanted.has(id));
}

/** Beats 1 to 4 of 9.5, exactly as A20 gives them. `r01` is the pattern the caller opens for
 * S (the canned `hero-s`, or the bare 7.3 variant of A19 that skips the `relied_on_by`
 * rewrites). `rewrites` is what the variant's landing is expected to hold. */
function beats1to4(
  s: SwarmSim,
  r01Id: string | ReturnType<typeof cannedCast>,
  rewrites = ["world/energy.js", "creatures/shrimp.js"],
): {
  shrimp: AgentHandle;
  crab: AgentHandle;
  r01: AgentHandle;
} {
  // Beat 1: the starter shrimp lands.
  const shrimp = s.open("hero-h");
  landNow(s, shrimp);

  // Beat 2: the crab writes `crab.energy < 30` and is held before its submit — so it is in
  // flight, with its write recorded, when R01 lands (the demo's race-card wait of 7.11).
  const crab = s.open("hero-c", { hold: true });
  drive(s, crab);
  expect(s.state(crab)).toBe("working");
  expect(s.attempt(crab)?.ops.some((o) => o.op === "write" && o.path === "creatures/crab.js")).toBe(true);

  // Beat 3: R01 — reads, the `replace`, its `relied_on_by` visits and repair ops — parks at
  // the held card, whose blast radius names the in-flight crab under `repair`.
  const r01 = s.open(r01Id);
  drive(s, r01);
  const card = s.cardOf(r01);
  expect(card?.kind).toBe("held");
  const radius = (card?.blast_radius as Record<string, { repair: string[] }> | undefined)?.[r01.id]?.repair;
  expect(radius).toEqual([crab.id]);

  // A20: the `relied_on_by` of S's `replace` has 16 referrers. The premise's members hold
  // the referrer keys (`#` names an entity) plus one `path@hash` entry per module.
  const refs = s.attempt(r01)?.premises.get("query|refs:world/energy.js#ENERGY_MAX");
  const referrers = (refs?.members ?? []).filter((m) => m.includes("#"));
  expect(referrers.length).toBe(16);

  s.tap(r01, "land");
  landNow(s, r01);

  // A20: S's change holds `world/energy.js` and `creatures/shrimp.js` (the bare variant of
  // A19 holds only `world/energy.js` — the shrimp keeps `drain(shrimp, 5)`).
  const r01Accepted = s.eventsOf("landing.accepted").find((e) => e.attempt_id === r01.id);
  expect(new Set((r01Accepted?.paths as string[] | undefined) ?? [])).toEqual(new Set(rewrites));
  expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
  if (rewrites.includes("creatures/shrimp.js")) {
    expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 0.05)");
  } else {
    expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
  }

  // Beat 4: E2 `repair` to the crab (the in-flight write of `crab.energy < 30` references
  // the altered `ENERGY_MAX`); it fixes `30` to `0.3` and lands third.
  const hus = s.headsUps(crab);
  expect(hus).toHaveLength(1);
  expect(hus[0]!.result).toBe("repair");
  expect(hus[0]!.items.map((i) => `${i.rule}:${i.premise.key}`)).toEqual(["E2:world/energy.js#ENERGY_MAX"]);
  s.release(crab);
  drive(s, crab);
  landNow(s, crab);
  expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
  return { shrimp, crab, r01 };
}

describe("P9 in the run of A20 (9.5): QT1 + QR1, the stale card, the final tree (A17)", () => {
  it("landing order starter, R01, crab, P9b, P9a; main as A17; verdict `ok`", { timeout: 30_000 }, () => {
    const s = sim();
    const beats = beats1to4(s, "hero-s");

    // Beat 5: the sweep searches `drain(`, changes `drain`, `liveOneTick` and the shrimp's
    // call, and submits — `held` with an empty blast radius (nothing in flight depends on
    // what it alters).
    const a = s.open("sweep-a");
    drive(s, a);
    expect(submitResults(s, a)).toEqual(["held"]);
    const firstCard = s.cardOf(a);
    expect(firstCard?.kind).toBe("held");
    expect((firstCard?.blast_radius as Record<string, { repair: string[] }>)[a.id]?.repair).toEqual([]);

    // P9b lands.
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
      expect(keys).toEqual(["creatures/squid.js#update"]);
      const squid = qt1.diff.added.find((x) => x.key === "creatures/squid.js#update")!;
      expect(squid.source).toContain("drain(squid, 0.1)");
    }

    // The held card closed as `stale`; a tap on it changes nothing (T8).
    expect(s.eventsOf("card.closed").some((e) => e.action === "stale" && e.card_id === firstCard?.card_id)).toBe(true);
    s.tap(a, "land");
    expect(s.state(a)).not.toBe("landed");

    // P9a's `replace` on the squid is accepted without a read (R1: the item's `added`
    // carried the source): the squid file has no `read` premise on the attempt.
    drive(s, a);
    const squidReads = [...(s.attempt(a)?.premises.values() ?? [])].filter(
      (p) => p.read === true && (p.key === "creatures/squid.js" || p.key.startsWith("creatures/squid.js#")),
    );
    expect(squidReads).toEqual([]);
    expect(
      s.attempt(a)?.ops.some((o) => o.op === "replace" && o.path === "creatures/squid.js" && o.dropped === false),
    ).toBe(true);
    // Its next submit answers `held` again — a new card opens; a tap lands the change.
    expect(submitResults(s, a)).toEqual(["held", "held"]);
    const secondCard = s.cardOf(a);
    expect(secondCard?.kind).toBe("held");
    expect(secondCard?.card_id).not.toBe(firstCard?.card_id);
    s.tap(a, "land");
    landNow(s, a);
    expect(s.state(a)).toBe("landed");

    // A20's landing order: starter, R01, crab, P9b, P9a.
    expect(landingOrder(s, [beats.shrimp, beats.r01, beats.crab, b, a])).toEqual([
      beats.shrimp.id,
      beats.r01.id,
      beats.crab.id,
      b.id,
      a.id,
    ]);

    // A17's `main`: ENERGY_MAX = 1, `drain` in percent, `drain(shrimp, 5)`,
    // `drain(squid, 10)`, `crab.energy < 0.3` — and the self-test verdict of the row:
    // `ok`; squid rest share at most 0.25; shrimp at most 0.15.
    const energy = s.files().get("world/energy.js")!;
    expect(energy).toContain("export const ENERGY_MAX = 1;");
    expect(energy).toContain("creature.energy - (percent / 100) * ENERGY_MAX");
    expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(s.files().get("creatures/squid.js")).toContain("drain(squid, 10)");
    expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
    const verdict = verdictOf(s.files(), makeReseed());
    expect(verdict.ok).toBe(true);
    expect(verdict.rest_share.squid).toBeLessThanOrEqual(0.25);
    expect(verdict.rest_share.shrimp).toBeLessThanOrEqual(0.15);
  });

  it("other order of A20: P9a lands first; E2 `repair` on `drain` sends the squid around", { timeout: 30_000 }, () => {
    const s = sim();
    beats1to4(s, "hero-s");

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
    const e2 = hus.find(
      (h) => h.result === "repair" && h.items.some((i) => i.rule === "E2" && i.premise.key === "world/energy.js#drain"),
    );
    expect(e2).toBeDefined();
    s.release(b);
    landNow(s, b);
    expect(s.state(b)).toBe("landed");
    expect(s.files().get("creatures/squid.js")).toContain("drain(squid, 10)");
  });
});

describe("the plain-merge and no-rewrite trees (A18, A19)", () => {
  /** Beat 5 in the same order, starting from the handles `beats` gives; returns the files. */
  function sweepThen(s: SwarmSim): ReadonlyMap<string, string> {
    const a = s.open("sweep-a");
    drive(s, a);
    const b = s.open("sweep-b");
    landNow(s, b);
    drive(s, a);
    s.tap(a, "land");
    landNow(s, a);
    return s.files();
  }

  it(
    "A18: as A17 with `< 30` and `drain(squid, 0.1)` — ok; the crab hides every tick; the squid rests 0",
    { timeout: 30_000 },
    () => {
      const s = sim();
      beats1to4(s, "hero-s");
      const files = new Map(sweepThen(s));
      // The plain-merge `main` of 9.5 (TP24): the two canned numbers the agents' repairs
      // would have fixed keep their old values — `30` in the crab, `0.1` in the squid.
      const crab = files.get("creatures/crab.js")!;
      expect(crab).toContain("crab.energy < 0.3");
      files.set("creatures/crab.js", crab.replace("crab.energy < 0.3", "crab.energy < 30"));
      const squid = files.get("creatures/squid.js")!;
      expect(squid).toContain("drain(squid, 10)");
      files.set("creatures/squid.js", squid.replace("drain(squid, 10)", "drain(squid, 0.1)"));

      const verdict = verdictOf(files, makeReseed());
      expect(verdict.ok).toBe(true);
      const stats = crabStatsOf(files, makeReseed(), 3600);
      expect(stats.hidden_share).toBe(1);
      expect(verdict.rest_share.squid).toBe(0);
    },
  );

  it(
    "A19: R01 lands without rewriting the landed shrimp — not `ok`, `failed` is exactly the shrimp's `not_exhausted`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      // "R01 lands without rewriting the landed shrimp": S's own canned operations of 7.3 —
      // `read GUIDE.md`, `read world/energy.js`, the `replace`, `submit` — without the
      // `relied_on_by` rewrites the canned `hero-s` applies on top of them.
      const r01Bare = cannedCast({
        id: "hero-s",
        intent: "make energy a fraction from 0 to 1",
        summary: "Make energy a fraction from 0 to 1",
        truth: ["entity:world/energy.js#ENERGY_MAX", "query:refs:world/energy.js#ENERGY_MAX"],
        script: [
          { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
          { tool: "read", args: { path: "world/energy.js" }, why: "energy" },
          {
            tool: "replace",
            args: {
              path: "world/energy.js",
              old: "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
              new: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
            },
            why: "rescale",
          },
        ],
      });
      beats1to4(s, r01Bare, ["world/energy.js"]);

      // A19's `main`: ENERGY_MAX = 1, `drain(shrimp, 5)` unrepaired, `crab.energy < 0.3`.
      expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
      expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
      expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
      const verdict = verdictOf(s.files(), makeReseed());
      expect(verdict.ok).toBe(false);
      expect(verdict.failed).toEqual([{ name: "not_exhausted", kind: "shrimp" }]);
    },
  );
});

describe("the undo of R01 (A21)", () => {
  it("before the sweep: reverts R01 and the crab, reopens the crab, keeps no reader", { timeout: 30_000 }, () => {
    const s = sim();
    const beats = beats1to4(s, "hero-s");
    const r01Seq = s.landingOf(beats.r01)!.seq;
    const crabSeq = s.landingOf(beats.crab)!.seq;

    s.trunk.owner({ action: "undo", seq: r01Seq });
    s.land();

    const planned = s.eventsOf("undo.planned")[0]!;
    expect(planned.target_seq).toBe(r01Seq);
    expect(planned.reverted).toEqual([r01Seq, crabSeq]);
    expect(planned.reopened).toEqual([beats.crab.id]);
    expect(planned.kept_readers).toEqual([]);
    expect(s.eventsOf("attempt.reopened").map((e) => e.attempt_id)).toEqual([beats.crab.id]);
    expect(s.state(beats.crab)).toBe("going_around");
    expect(s.state(beats.r01)).toBe("stopped");

    // The reverted files are gone or restored: energy back to points, the shrimp's `5`,
    // and the crab's file is not on `main` any more.
    expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 100;");
    expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(s.files().has("creatures/crab.js")).toBe(false);
  });

  it("after the sweep: reverts R01, the crab, P9b and P9a; reopens three attempts", { timeout: 30_000 }, () => {
    const s = sim();
    const beats = beats1to4(s, "hero-s");
    const a = s.open("sweep-a");
    drive(s, a);
    const b = s.open("sweep-b");
    landNow(s, b);
    drive(s, a);
    s.tap(a, "land");
    landNow(s, a);

    const r01Seq = s.landingOf(beats.r01)!.seq;
    const crabSeq = s.landingOf(beats.crab)!.seq;
    const bSeq = s.landingOf(b)!.seq;
    const aSeq = s.landingOf(a)!.seq;

    s.trunk.owner({ action: "undo", seq: r01Seq });
    s.land();

    const planned = s.eventsOf("undo.planned")[0]!;
    expect(planned.reverted).toEqual([r01Seq, crabSeq, bSeq, aSeq]);
    expect(planned.reopened).toEqual([beats.crab.id, b.id, a.id]);
    expect(s.eventsOf("attempt.reopened").map((e) => e.attempt_id)).toEqual([beats.crab.id, b.id, a.id]);
    expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 100;");
    expect(s.files().has("creatures/crab.js")).toBe(false);
    expect(s.files().has("creatures/squid.js")).toBe(false);
  });
});

describe("the B1 variant of A20: P9a without a read of `ENERGY_MAX`", () => {
  it("B1 `confirm` at its first submit, then `held` as before", { timeout: 30_000 }, () => {
    const s = sim();
    beats1to4(s, "hero-s");

    // The same cast minus the `read` of `energy#ENERGY_MAX` (A20: "P9a without a read of
    // `ENERGY_MAX`"): the new `drain` references it — a blind spot of B1.
    const a = s.open(sweepACast(false));
    drive(s, a);
    expect(submitResults(s, a)[0]).toBe("needs_confirm");
    const hus = s.headsUps(a);
    expect(hus).toHaveLength(1);
    expect(hus[0]!.result).toBe("confirm");
    expect(hus[0]!.items.map((i) => `${i.rule}:${i.premise.key}`)).toEqual(["B1:world/energy.js#ENERGY_MAX"]);
    expect(
      judgmentsOf(s, a).some(
        (j) => j.rule === "B1" && j.result === "confirm" && j.key === "world/energy.js#ENERGY_MAX",
      ),
    ).toBe(true);

    // Answered, the same run continues: `held`, the card, P9b, QT1 + QR1 — as in A20.
    drive(s, a);
    expect(submitResults(s, a)).toEqual(["needs_confirm", "held"]);
    const b = s.open("sweep-b");
    landNow(s, b);
    drive(s, a);
    s.tap(a, "land");
    landNow(s, a);
    expect(s.state(a)).toBe("landed");
    expect(s.files().get("creatures/squid.js")).toContain("drain(squid, 10)");
  });
});
