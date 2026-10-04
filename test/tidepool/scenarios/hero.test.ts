// The hero conflict of 02-tidepool.md section 7 played by the canned cast of 10.5 and paced
// by the conductor of 7.11, through the real `Trunk` engine on a pool of seed `tidepool` and
// `tidepool-auto` (the Appendix A rows A3 to A7, A9, A10, A11 and A12). Expected values come
// from section 7 and Appendix A, never from the implementation (BP1).

import { describe, expect, it } from "vitest";
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
    it("A3/A5/A6/A10/A12: S lands first; E2 sends C and H around; J undisturbed", () => {
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
    it("A4/A7/A11: creatures land while S waits; QR1 sends S around; stale card; same tree", () => {
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

      // S received `repair` with rule QR1 naming the new referrers (7.6 step 4).
      const qr1 = s.headsUps(S).find((h) => h.result === "repair" && h.items.some((i) => i.rule === "QR1"));
      expect(qr1).toBeDefined();
      const added = qr1!.items.flatMap((i) => (i.diff.kind === "query" ? i.diff.added.map((a) => a.key) : []));
      expect(added).toContain("creatures/crab.js#(import ../world/energy.js)");
      expect(added).toContain("creatures/shrimp.js#(import ../world/energy.js)");

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
    });
  });
}
