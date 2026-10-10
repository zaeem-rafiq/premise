// The hero conflict of 02-tidepool.md section 7 played by the canned cast of 10.5 and paced
// by the conductor of 7.11, through the real `Trunk` engine on a pool of seed `tidepool` and
// `tidepool-auto` (the Appendix A rows A3 to A7, A9, A10, A11 and A12). Expected values come
// from section 7 and Appendix A, never from the implementation (BP1).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScratchRepo } from "../../support/git.ts";
import { SwarmSim, tidepoolAutoFiles, tidepoolFiles, type AgentHandle } from "../../integration/collide/harness.ts";
import { conduct } from "./conduct.ts";

function sim(seed: "tidepool" | "tidepool-auto"): SwarmSim {
  return new SwarmSim(seed === "tidepool" ? tidepoolFiles() : tidepoolAutoFiles(), {
    seed: 7,
    synthetic: true,
    features_held: seed === "tidepool", // FJ1: `tidepool` pools run with `features.held`
  });
}

const rules = (sim: SwarmSim, agent: AgentHandle, result: string): string[] =>
  sim
    .eventsOf("headsup.sent")
    .filter((e) => e.attempt_id === agent.id && e.result === result)
    .flatMap((e) => (e.keys as Array<{ rule: string }>).map((k) => k.rule));

const goArounds = (sim: SwarmSim, agent: AgentHandle): number => sim.attempt(agent)?.go_arounds ?? -1;

function mainTree(sim: SwarmSim): Map<string, string> {
  return new Map(sim.files());
}

function expectHeroTree(files: Map<string, string>): void {
  expect(files.get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
  expect(files.get("world/energy.js")).toContain("Energy is a fraction");
  expect(files.get("creatures/crab.js")).toContain("crab.energy < 0.3");
  expect(files.get("creatures/crab.js")).not.toContain("crab.energy < 30");
  expect(files.get("creatures/shrimp.js")).toContain("drain(shrimp, 0.05)");
  expect(files.get("creatures/shrimp.js")).not.toContain("drain(shrimp, 5)");
  expect(files.get("creatures/jellyfish.js")).toContain('const BELL = "purple"');
}

for (const seed of ["tidepool", "tidepool-auto"] as const) {
  describe(`hero conflict, landing order 1 (7.5, 7.11) on ${seed}`, () => {
    it("A3/A5/A6/A10/A12: S lands first; E2 sends C and H around; J undisturbed", { timeout: 30_000 }, () => {
      const s = sim(seed);
      const { agents, conductor } = conduct(s, 1, seed);
      const S = agents.get("hero-s")!;
      const C = agents.get("hero-c")!;
      const H = agents.get("hero-h")!;
      const J = agents.get("hero-j")!;
      expect(conductor.done).toBe(true);

      // End state of 7.5: S landed with 0 go-arounds; C and H landed with 1; J with 0.
      for (const a of [S, C, H, J]) expect(s.state(a)).toBe("landed");
      expect(goArounds(s, S)).toBe(0);
      expect(goArounds(s, C)).toBe(1);
      expect(goArounds(s, H)).toBe(1);
      expect(goArounds(s, J)).toBe(0);

      // C and H each received `repair` carrying rule E2 (7.5 step 3); J received no heads-up.
      expect(rules(s, C, "repair")).toContain("E2");
      expect(rules(s, H, "repair")).toContain("E2");
      expect(s.headsUps(J)).toHaveLength(0);

      // A12: on `tidepool` the held card of S's submit listed C and H under `repair`.
      if (seed === "tidepool") {
        const card = s
          .eventsOf("card.opened")
          .map((e) => e.card as { kind: string; blast_radius: Record<string, { repair: string[] }> })[0];
        expect(card?.kind).toBe("held");
        const blast = card?.blast_radius?.[S.id]?.repair ?? [];
        expect(new Set(blast)).toEqual(new Set([C.id, H.id]));
      }

      expectHeroTree(mainTree(s));
    });
  });

  describe(`hero conflict, landing order 2 (7.6, 7.11) on ${seed}`, () => {
    it(
      "A4/A7/A11/B1a: creatures land while S waits; QR1 sends S around; stale card; same tree",
      { timeout: 30_000 },
      () => {
        const s = sim(seed);
        const { agents, conductor } = conduct(s, 2, seed);
        const S = agents.get("hero-s")!;
        const C = agents.get("hero-c")!;
        const H = agents.get("hero-h")!;
        const J = agents.get("hero-j")!;
        expect(conductor.done).toBe(true);

        for (const a of [S, C, H, J]) expect(s.state(a)).toBe("landed");
        // 7.6 end state: C and H landed with 0 go-arounds; S landed with 1.
        expect(goArounds(s, C)).toBe(0);
        expect(goArounds(s, H)).toBe(0);
        expect(goArounds(s, J)).toBe(0);
        expect(goArounds(s, S)).toBe(1);

        // S received `repair` with rule QR1 naming the four new referrers (7.6 step 4), with
        // a `context` of eleven entities that includes the two `update` sources.
        const qr1 = s.headsUps(S).find((h) => h.result === "repair" && h.items.some((i) => i.rule === "QR1"));
        expect(qr1).toBeDefined();
        const qr1Item = qr1!.items.find((i) => i.rule === "QR1")!;
        const added = qr1Item.diff.kind === "query" ? qr1Item.diff.added.map((a) => a.key) : [];
        expect(added.sort()).toEqual(
          [
            "creatures/crab.js#(import ../world/energy.js)",
            "creatures/crab.js#spawn",
            "creatures/shrimp.js#(import ../world/energy.js)",
            "creatures/shrimp.js#spawn",
          ].sort(),
        );
        const context = qr1Item.diff.kind === "query" ? qr1Item.diff.context.map((x) => x.key) : [];
        expect(context).toHaveLength(11);
        expect(context).toContain("creatures/crab.js#update");
        expect(context).toContain("creatures/shrimp.js#update");

        // A11: S's two `replace` calls on the creature files are accepted without a read;
        // its next submit answers `held` and records no B1 judgment (B1a).
        expect(
          s
            .attempt(S)
            ?.ops.filter((o) => o.op === "replace" && o.path.startsWith("creatures/"))
            .map((o) => o.path),
        ).toEqual(["creatures/crab.js", "creatures/shrimp.js"]);
        expect(
          [...(s.attempt(S)?.premises.values() ?? [])].some(
            (p) => p.read === true && (p.key === "creatures/crab.js" || p.key === "creatures/shrimp.js"),
          ),
        ).toBe(false);
        if (seed === "tidepool") {
          const sSubmits = s
            .eventsOf("submit.result")
            .filter((e) => e.attempt_id === S.id)
            .map((e) => e.status);
          expect(sSubmits.at(-1)).toBe("held");
        }
        expect([...s.trunk.pool.judgments.values()].some((j) => j.attempt_id === S.id && j.rule === "B1")).toBe(false);

        // 7.6 step 6: S's resubmit acknowledges the heads-up with the statement of the section,
        // and its one landing alters `world/energy.js` and both creature modules (D1/D2).
        const resolved = s.eventsOf("headsup.resolved").find((e) => e.attempt_id === S.id);
        expect(resolved?.statement).toBe(
          "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change.",
        );
        const sLanding = s.eventsOf("landing.accepted").find((e) => e.attempt_id === S.id);
        expect(new Set(sLanding?.paths as string[])).toEqual(
          new Set(["world/energy.js", "creatures/crab.js", "creatures/shrimp.js"]),
        );

        if (seed === "tidepool") {
          // The first card closed as `stale`; a second `held` card opened for the resubmit (T8).
          const stale = s.eventsOf("card.closed").filter((e) => e.action === "stale");
          expect(stale.length).toBe(1);
          expect(s.eventsOf("card.opened").length).toBe(2);
        }

        expectHeroTree(mainTree(s));
      },
    );
  });
}

// ---- A9: the premises of 7.4 and the judgments of 7.5, paced by hand on `tidepool` ----

import { heroCCast } from "../../../src/swarm/casts/hero-c.ts";
import { cannedCast } from "../../../src/swarm/casts/runner.ts";
import { crabStatsOf, verdictOf } from "./eval.ts";
import { specBlock } from "../spec.ts";

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

function makeReseed(): (n: number) => void {
  const source = specBlock("replace `Math.random` with the generator below", "```js");
  const build = new Function(`${source}\nreturn mulberry32;`) as () => (seed: number) => () => number;
  const mulberry32 = build();
  return (n: number): void => {
    Math.random = mulberry32(n);
  };
}

/** The judgments the engine recorded for an attempt, as `{rule, kind, key, result}`. */
function judgmentsOf(s: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return [...s.trunk.pool.judgments.values()].filter((j) => j.attempt_id === agent.id);
}

/** One premise's flags as the table of 7.4 names them, or undefined. */
function premise(s: SwarmSim, agent: AgentHandle, key: string): Record<string, unknown> | undefined {
  return s.attempt(agent)?.premises.get(key) as Record<string, unknown> | undefined;
}

function flags(s: SwarmSim, agent: AgentHandle, key: string): { read?: boolean; edit?: boolean; derived?: boolean } {
  const p = premise(s, agent, key);
  return { read: p?.read as boolean, edit: p?.edit as boolean, derived: p?.derived as boolean };
}

describe("7.4/7.5 premises and judgments (A9)", () => {
  it(
    "derived premises exist after each `write` and after S's `replace`; two judgments for H, one item; the four landings in order",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const C = s.open("hero-c", { hold: true });
      const H = s.open("hero-h", { hold: true });
      const J = s.open("hero-j", { hold: true });
      drive(s, C);
      drive(s, H);
      drive(s, J);

      // 7.4, C: the reads, the four entities (read + derived at the `write`), the file at `absent`.
      expect(flags(s, C, "listing|creatures/")).toMatchObject({ read: true });
      expect(flags(s, C, "file|GUIDE.md")).toMatchObject({ read: true });
      for (const key of [
        "entity|world/energy.js#ENERGY_MAX",
        "entity|world/bounds.js#FLOOR_Y",
        "entity|world/bounds.js#bounce",
        "entity|world/movement.js#step",
      ]) {
        expect(flags(s, C, key), key).toMatchObject({ read: true, derived: true });
      }
      expect(flags(s, C, "file|creatures/crab.js")).toMatchObject({ edit: true });

      // 7.4, H: four file reads, seven derived entity premises at the `write`, the file at `absent`.
      for (const key of [
        "listing|creatures/",
        "file|GUIDE.md",
        "file|world/energy.js",
        "file|world/bounds.js",
        "file|world/time.js",
        "file|world/movement.js",
      ]) {
        expect(flags(s, H, key), key).toMatchObject({ read: true });
      }
      for (const key of [
        "entity|world/energy.js#ENERGY_MAX",
        "entity|world/energy.js#drain",
        "entity|world/bounds.js#bounce",
        "entity|world/time.js#seconds",
        "entity|world/movement.js#step",
        "entity|world/movement.js#wander",
        "entity|world/movement.js#glide",
      ]) {
        expect(flags(s, H, key), key).toMatchObject({ derived: true });
      }
      expect(flags(s, H, "file|creatures/shrimp.js")).toMatchObject({ edit: true });

      // 7.4, J: the reads, two entities (read + derived), the file at `absent`.
      for (const key of ["listing|creatures/", "file|GUIDE.md"]) {
        expect(flags(s, J, key)).toMatchObject({ read: true });
      }
      for (const key of ["entity|world/bounds.js#SURFACE_Y", "entity|world/bounds.js#FLOOR_Y"]) {
        expect(flags(s, J, key), key).toMatchObject({ read: true, derived: true });
      }
      expect(flags(s, J, "file|creatures/jellyfish.js")).toMatchObject({ edit: true });

      // S opens and runs to its held card; after its `replace` the premises of 7.4 stand.
      const S = s.open("hero-s");
      drive(s, S);
      expect(s.state(S)).toBe("held");
      expect(flags(s, S, "file|GUIDE.md")).toMatchObject({ read: true });
      expect(flags(s, S, "file|world/energy.js")).toMatchObject({ read: true });
      expect(flags(s, S, "entity|world/energy.js#ENERGY_MAX")).toMatchObject({ edit: true, derived: true });
      for (const key of [
        "entity|world/energy.js#HUNGRY_BELOW",
        "entity|world/energy.js#LIVING_COST",
        "entity|world/energy.js#REST_TICKS",
        "entity|world/energy.js#drain",
      ]) {
        expect(flags(s, S, key), key).toMatchObject({ derived: true });
      }
      expect(flags(s, S, "query|refs:world/energy.js#ENERGY_MAX")).toMatchObject({ derived: true });

      // A9: the card for S names C and H under `repair`, and nothing else.
      const card = s.cardOf(S);
      expect(card?.kind).toBe("held");
      const radius = (card?.blast_radius as Record<string, { repair: string[]; confirm: string[]; triage: string[] }>)[
        S.id
      ];
      expect(new Set(radius?.repair)).toEqual(new Set([C.id, H.id]));
      expect(radius?.confirm).toEqual([]);
      expect(radius?.triage).toEqual([]);

      s.tap(S, "land");
      landNow(s, S);
      expect(s.landingOf(S)?.seq).toBe(1);

      // At S's landing: one `repair` heads-up each for C and H, exactly one item in each —
      // the entity (H's file item is folded, HU2a); nothing for J.
      for (const a of [C, H]) {
        const hus = s.headsUps(a);
        expect(hus).toHaveLength(1);
        expect(hus[0]!.result).toBe("repair");
        expect(hus[0]!.items.map((i) => `${i.rule}:${i.premise.key}`)).toEqual(["E2:world/energy.js#ENERGY_MAX"]);
        expect(hus[0]!.go_around).toBe(1);
      }
      expect(s.headsUps(J)).toHaveLength(0);
      expect(judgmentsOf(s, J)).toHaveLength(0);

      // Two judgments are recorded for H, both `repair`: E2 on the entity, F3 on the file.
      const hJudgments = judgmentsOf(s, H);
      expect(hJudgments).toHaveLength(2);
      expect(hJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "E2", kind: "entity", key: "world/energy.js#ENERGY_MAX", result: "repair" }),
          expect.objectContaining({ rule: "F3", kind: "file", key: "world/energy.js", result: "repair" }),
        ]),
      );
      expect(judgmentsOf(s, C)).toEqual([
        expect.objectContaining({ rule: "E2", kind: "entity", key: "world/energy.js#ENERGY_MAX", result: "repair" }),
      ]);

      // C's and H's next submits: no new premise, no B1, `validated` — with the statements
      // of 7.5 steps 6 and 7 as their acknowledgements.
      for (const a of [C, H, J]) s.release(a);
      for (const a of [C, H]) {
        drive(s, a);
        const evts = s.events();
        const submitAt = evts.findLastIndex((e) => e.type === "submit.result" && e.attempt_id === a.id);
        const premiseAfter = evts.some(
          (e, i) => i > submitAt && e.type === "premise.recorded" && e.attempt_id === a.id,
        );
        expect(premiseAfter).toBe(false);
        expect(
          s
            .eventsOf("submit.result")
            .filter((e) => e.attempt_id === a.id)
            .map((e) => e.status),
        ).toEqual(["validated"]);
        expect(judgmentsOf(s, a).some((j) => j.rule === "B1")).toBe(false);
      }
      const cResolved = s.eventsOf("headsup.resolved").find((e) => e.attempt_id === C.id);
      expect(cResolved?.statement).toBe("Energy is now a fraction from 0 to 1, so the crab hides below 0.3.");
      const hResolved = s.eventsOf("headsup.resolved").find((e) => e.attempt_id === H.id);
      expect(hResolved?.statement).toBe("Energy is now a fraction from 0 to 1, so a dart costs 0.05.");

      drive(s, J);
      s.land(); // one batch accepts C, H and J as landings 2, 3 and 4 (7.5 step 9).
      for (const [a, seq] of [
        [C, 2],
        [H, 3],
        [J, 4],
      ] as const) {
        expect(s.landingOf(a)?.seq).toBe(seq);
      }
      const batch = s.eventsOf("landing.accepted").filter((e) => [C.id, H.id, J.id].includes(e.attempt_id as string));
      expect(new Set(batch.map((e) => e.batch_id)).size).toBe(1);
      // L3: the batch's earlier member changed the `creatures/` listing H and J hold — `holds`.
      for (const a of [H, J]) {
        expect(judgmentsOf(s, a).some((j) => j.rule === "L3" && j.result === "holds" && j.key === "creatures/")).toBe(
          true,
        );
      }
      // Go-arounds S 0, C 1, H 1, J 0.
      expect([S, C, H, J].map((a) => goArounds(s, a))).toEqual([0, 1, 1, 0]);
      expectHeroTree(mainTree(s));
    },
  );
});

describe("variant 1c of 7.5 (A10): the crab's agent never reads `ENERGY_MAX`", () => {
  it(
    "written before S lands: a derived premise with `read` false, E2 `repair`, no B1, one go-around",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const C = s.open(heroCCast(false), { hold: true });
      drive(s, C);
      // A10: at the write a derived premise `entity:world/energy.js#ENERGY_MAX` with `read` false.
      expect(flags(s, C, "entity|world/energy.js#ENERGY_MAX")).toMatchObject({ read: false, derived: true });

      const S = s.open("hero-s");
      drive(s, S);
      s.tap(S, "land");
      landNow(s, S);

      // E2 `repair` at S's landing; then no B1 at the submit, `validated`, one go-around.
      const hus = s.headsUps(C);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("repair");
      expect(hus[0]!.items.map((i) => i.rule)).toEqual(["E2"]);
      s.release(C);
      drive(s, C);
      expect(
        s
          .eventsOf("submit.result")
          .filter((e) => e.attempt_id === C.id)
          .map((e) => e.status),
      ).toEqual(["validated"]);
      expect(judgmentsOf(s, C).some((j) => j.rule === "B1")).toBe(false);
      landNow(s, C);
      expect(goArounds(s, C)).toBe(1);
      expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
    },
  );

  it(
    "written after S landed: B1 `confirm` at the submit (`needs_confirm`), then `validated`, 0 go-arounds",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const S = s.open("hero-s");
      drive(s, S);
      s.tap(S, "land");
      landNow(s, S);

      const C = s.open(heroCCast(false));
      drive(s, C);
      const submits = () =>
        s
          .eventsOf("submit.result")
          .filter((e) => e.attempt_id === C.id)
          .map((e) => e.status);
      // B1: the new file references `ENERGY_MAX`, whose source C was never shown — `confirm`,
      // `needs_confirm`; then the canned repair and `validated`.
      const hus = s.headsUps(C);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(hus[0]!.items.map((i) => `${i.rule}:${i.premise.key}`)).toEqual(["B1:world/energy.js#ENERGY_MAX"]);
      expect(submits()[0]).toBe("needs_confirm");
      drive(s, C);
      expect(submits()).toEqual(["needs_confirm", "validated"]);
      landNow(s, C);
      expect(goArounds(s, C)).toBe(0);
      // C lands with the same final file as ever (7.5's 1c): `crab.energy < 0.3`.
      expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 0.3");
    },
  );
});

describe("7.7 who is not sent back (A12)", () => {
  const RETUNE_150 = cannedCast({
    id: "retune",
    intent: "retune REST_TICKS",
    truth: ["entity:world/energy.js#REST_TICKS"],
    script: [
      { tool: "read", args: { path: "world/energy.js", entity: "REST_TICKS" }, why: "read" },
      {
        tool: "replace",
        args: { path: "world/energy.js", old: "export const REST_TICKS = 300;", new: "export const REST_TICKS = 150;" },
        why: "edit",
      },
    ],
  });

  it(
    "a comment-only landing: F2 `holds` for H, nothing for C or J, no heads-up; a `REST_TICKS` landing: F4 `info` for H, nothing for C or J",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const C = s.open("hero-c", { hold: true });
      const H = s.open("hero-h", { hold: true });
      const J = s.open("hero-j", { hold: true });
      drive(s, C);
      drive(s, H);
      drive(s, J);

      // R10: a comment in `world/energy.js` is reworded — the canned `cosmetic` lands it.
      const r10 = s.open("cosmetic");
      drive(s, r10);
      s.tap(r10, "land");
      landNow(s, r10);
      expect(s.headsUps(C)).toHaveLength(0);
      expect(s.headsUps(H)).toHaveLength(0);
      expect(s.headsUps(J)).toHaveLength(0);
      expect(judgmentsOf(s, C)).toHaveLength(0);
      expect(judgmentsOf(s, J)).toHaveLength(0);
      // F2 `holds` for H — the file blob moved, no entity did.
      expect(judgmentsOf(s, H)).toEqual([
        expect.objectContaining({ rule: "F2", kind: "file", key: "world/energy.js", result: "holds" }),
      ]);

      // R07: `REST_TICKS` 300 -> 150 lands while the same attempts are in flight — F4 triage
      // for H (it read the file but does not reference `REST_TICKS`), answered `holds` by the
      // scripted triage, arriving as an `info` heads-up; nothing for C or J.
      const r07 = s.open(RETUNE_150);
      drive(s, r07);
      s.tap(r07, "land");
      landNow(s, r07);
      expect(s.headsUps(C)).toHaveLength(0);
      expect(s.headsUps(J)).toHaveLength(0);
      const hus = s.headsUps(H);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("info");
      expect(hus[0]!.items.map((i) => `${i.rule}:${i.premise.key}`)).toEqual(["F4:world/energy.js"]);
      expect(
        judgmentsOf(s, H).some(
          (j) => j.rule === "F4" && j.result === "holds" && j.key === "world/energy.js" && j.klass === "triage",
        ),
      ).toBe(true);
      expect(judgmentsOf(s, C)).toHaveLength(0);
      expect(judgmentsOf(s, J)).toHaveLength(0);
    },
  );
});

describe("the self-test verdicts of the hero trees (A3, A4, A5)", () => {
  it(
    "A3: seed + the canned crab, shrimp and jellyfish in points — `ok`; the shrimp rests at most 0.15",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      for (const id of ["hero-c", "hero-h", "hero-j"]) landNow(s, s.open(id));
      expect(s.files().get("world/energy.js")).toContain("export const ENERGY_MAX = 100;");
      expect(s.files().get("creatures/crab.js")).toContain("crab.energy < 30");
      expect(s.files().get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
      const verdict = verdictOf(s.files(), makeReseed());
      expect(verdict.ok).toBe(true);
      expect(verdict.rest_share.shrimp).toBeLessThanOrEqual(0.15);
    },
  );

  it(
    "A4: the section-7 pool — `ok`; the shrimp rests at most 0.15; the crab hides at most 0.10 and moves at least 0.8 a tick",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const { conductor } = conduct(s, 2, "tidepool");
      expect(conductor.done).toBe(true);
      const verdict = verdictOf(s.files(), makeReseed());
      expect(verdict.ok).toBe(true);
      expect(verdict.rest_share.shrimp).toBeLessThanOrEqual(0.15);
      const crab = crabStatsOf(s.files(), makeReseed(), 3600);
      expect(crab.hidden_share).toBeLessThanOrEqual(0.1);
      expect(crab.mean_speed).toBeGreaterThanOrEqual(0.8);
    },
  );

  it(
    "A5: the plain-merge pool of 7.8 — not `ok`; `not_exhausted` on the shrimp; the crab hides every tick at speed 0",
    { timeout: 30_000 },
    () => {
      const s = sim("tidepool");
      const { conductor } = conduct(s, 1, "tidepool");
      expect(conductor.done).toBe(true);
      const files = new Map(s.files());
      // The plain-merge tree (7.8): the same landings replayed with `ops_first` — the crab's
      // `30` and the shrimp's `5` keep their old-scale values under `ENERGY_MAX = 1`.
      files.set("creatures/crab.js", files.get("creatures/crab.js")!.replace("crab.energy < 0.3", "crab.energy < 30"));
      files.set(
        "creatures/shrimp.js",
        files.get("creatures/shrimp.js")!.replace("drain(shrimp, 0.05)", "drain(shrimp, 5)"),
      );
      const verdict = verdictOf(files, makeReseed());
      expect(verdict.ok).toBe(false);
      expect(verdict.failed).toEqual([{ name: "not_exhausted", kind: "shrimp" }]);
      expect(verdict.rest_share.shrimp).toBeGreaterThanOrEqual(0.6);
      expect(verdict.rest_share.crab).toBeLessThanOrEqual(0.25);
      const crab = crabStatsOf(files, makeReseed(), 3600);
      expect(crab.hidden_share).toBe(1);
      expect(crab.mean_speed).toBe(0);
    },
  );
});

// PM3a (01-core.md 11.7, added 2026-10-10): the hero's landing order 1 played through the real
// engine, then the plain-merge pool built with `features.text_merge` on. 7.8 says every replay of
// order 1 succeeds and names the tree; a three-way merge must agree, since the four changes touch
// four different files. The tree id is checked against `git write-tree` of 7.8's files.
describe("the plain-merge pool of 7.8 with features.text_merge (PM3a)", () => {
  it(
    "PM3a: hero order 1 through the engine: no text conflict, 7.8's tree, the same tree as PM3",
    { timeout: 60_000 },
    () => {
      const s = sim("tidepool");
      const { conductor } = conduct(s, 1, "tidepool");
      expect(conductor.done).toBe(true);
      const off = s.trunk.plain();
      if (off.state !== "build") throw new Error(`expected a plain build, got ${off.state}`);
      s.trunk.pool.meta.delete("plain_pending"); // build again from scratch with the switch on
      s.trunk.pool.featuresTextMerge = true;
      const on = s.trunk.plain();
      if (on.state !== "build") throw new Error(`expected a plain build, got ${on.state}`);
      expect(on.skipped).toEqual([]); // 7.8: the text-conflict count is 0
      expect(on.through_seq).toBe(off.through_seq);
      expect(on.tree).toBe(off.tree);
      // 7.8's tree: ENERGY_MAX = 1, `crab.energy < 30`, `drain(shrimp, 5)` — from the files of `main`
      // with the two creature lines put back to their old-scale values.
      const expected = new Map(s.files());
      expected.set(
        "creatures/crab.js",
        expected.get("creatures/crab.js")!.replace("crab.energy < 0.3", "crab.energy < 30"),
      );
      expected.set(
        "creatures/shrimp.js",
        expected.get("creatures/shrimp.js")!.replace("drain(shrimp, 0.05)", "drain(shrimp, 5)"),
      );
      expect(expected.get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
      const repo = createScratchRepo("premise-hero-pm3a-");
      try {
        for (const [path, content] of expected) {
          const full = join(repo.directory, path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }
        repo.git("add", "-A");
        expect(on.tree).toBe(repo.git("write-tree"));
      } finally {
        repo.remove();
      }
    },
  );
});
