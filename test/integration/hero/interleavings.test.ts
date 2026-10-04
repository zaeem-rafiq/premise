// Every interleaving of the hero cast (02-tidepool.md 7.5, 7.6 and 10.5), in the style of
// test/integration/collide/interleavings.test.ts: for each ordered pair of `hero-s`,
// `hero-c`, `hero-h` and `hero-j`, and for every script position `k` of the first agent,
// agent A runs `k` tool calls, agent B runs to its landing, and A finishes (released when
// held). The pool is the seed `tidepool-auto`, where the shared rule is `auto` (02 6), so
// no card paces the run and every landed attempt lands by itself.
//
// Expected outcomes are written from the specification, never from the engine's output
// (BP1):
//
//   - S landing while a creature is in flight: nothing before the creature read
//     `ENERGY_MAX`; an `info` heads-up once it did and before its `write` (X0 `no_patch_yet`,
//     or the canned `holds` of a read_not_referenced triage, TR8); a `repair` heads-up once
//     the `write` is recorded (E2, the file judgment folded by HU2a);
//   - a creature landing while S is in flight: a `repair` heads-up once S's `replace` is
//     recorded (QR1, `refs:` gained the creature's module); the jellyfish references nothing
//     about energy, so it never disturbs and is never disturbed (7.7);
//   - a creature landing while another creature is in flight: `listing_unused` (L3), a
//     recorded `holds` and no heads-up;
//   - whenever both landed the final tree is the one of 04-build-plan.md 2.7 item 2:
//     `ENERGY_MAX = 1`, `crab.energy < 0.3`, `drain(shrimp, 0.05)` for the members that are
//     in the run, and no attempt is left in flight.

import { describe, expect, it } from "vitest";
import { SwarmSim, tidepoolAutoFiles, type AgentHandle } from "../collide/harness.ts";

/** Drive one agent until it parks (a `wait` step, a `stop`, or a terminal state). */
function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 60; i += 1) {
    if (!sim.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 60 calls");
}

/** The `headsup.sent` events recorded for `agent`. */
function sentTo(sim: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return sim.eventsOf("headsup.sent").filter((e) => e.attempt_id === agent.id);
}

/** The tool-call count of each cast's script on the tidepool seed, the submit the runner
 * issues included (the same convention as `interleavings.test.ts`): S reads GUIDE.md and
 * `world/energy.js`, replaces, reads the `update` of each seed creature `relied_on_by`
 * names (`fish`, `minnow`, `turtle`) and submits — seven calls. The creatures' scripts are
 * the rows of 7.3 plus the write and the submit. */
const SCRIPT_LEN: Record<string, number> = {
  "hero-s": 7,
  "hero-c": 8,
  "hero-h": 8,
  "hero-j": 6,
};

const CAST = ["hero-s", "hero-c", "hero-h", "hero-j"] as const;

/** What B's landing sends to A while A has run `k` calls, per 7.5 to 7.7. */
type Disturbance = "none" | "info" | "repair";

function aDisturbance(pa: string, pb: string, k: number): Disturbance {
  if (pa === "hero-s") {
    // A creature that references `ENERGY_MAX` lands while S is in flight: QR1 once S's
    // `replace` recorded the `refs:` premise (k = 3). J references nothing about energy.
    if (pb === "hero-c" || pb === "hero-h") return k >= 3 ? "repair" : "none";
    return "none";
  }
  if (pa === "hero-j") return "none"; // J is never sent back (7.7)
  if (pb === "hero-s") {
    // S lands while the creature is in flight: nothing before the `ENERGY_MAX` read
    // (call index 2, so k = 3); `info` while no `write` is recorded yet (X0/TR8); E2
    // `repair` once the `write` is (k = 7).
    if (k < 3) return "none";
    return k < 7 ? "info" : "repair";
  }
  return "none"; // a creature's landing disturbs no creature (L3 `holds`)
}

function runInterleaving(
  pa: string,
  pb: string,
  k: number,
  hold: boolean,
): { sim: SwarmSim; a: AgentHandle; b: AgentHandle } {
  const sim = new SwarmSim(tidepoolAutoFiles(), { seed: 7, synthetic: true });
  const a = sim.open(pa, { hold });
  for (let i = 0; i < k; i += 1) sim.step(a);

  const b = sim.open(pb);
  drive(sim, b);
  sim.land(); // B's accept transaction lands it and pushes the heads-ups (HU5b)

  if (hold) {
    // B landed while A was parked; A is released and finishes against the heads-up.
    expect(sim.state(b)).toBe("landed");
    sim.release(a);
    sim.settle();
  } else {
    // A submitted before B and lands first; B is the in-flight attempt now.
    expect(sim.state(a)).toBe("landed");
    sim.settle();
  }
  return { sim, a, b };
}

function checkDisturbance(sim: SwarmSim, disturbed: AgentHandle, want: Disturbance): void {
  const sent = sentTo(sim, disturbed);
  if (want === "none") {
    expect(sent).toEqual([]);
  } else if (want === "info") {
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) expect(e.result).toBe("info");
  } else {
    expect(sent.some((e) => e.result === want)).toBe(true);
  }
  expect(sim.state(disturbed)).toBe("landed");
}

/** The tree of 04-build-plan.md 2.7 item 2, limited to the members of the run. */
function checkFinalTree(sim: SwarmSim, pa: string, pb: string): void {
  const files = sim.files();
  const withS = pa === "hero-s" || pb === "hero-s";
  const energy = files.get("world/energy.js") ?? "";
  if (withS) {
    expect(energy).toContain("export const ENERGY_MAX = 1;");
  } else {
    expect(energy).toContain("export const ENERGY_MAX = 100;");
  }
  if (pa === "hero-c" || pb === "hero-c") {
    const crab = files.get("creatures/crab.js") ?? "";
    expect(crab).toContain(withS ? "crab.energy < 0.3" : "crab.energy < 30");
    if (withS) expect(crab).not.toContain("crab.energy < 30;");
  }
  if (pa === "hero-h" || pb === "hero-h") {
    const shrimp = files.get("creatures/shrimp.js") ?? "";
    expect(shrimp).toContain(withS ? "drain(shrimp, 0.05)" : "drain(shrimp, 5)");
    if (withS) expect(shrimp).not.toContain("drain(shrimp, 5)");
  }
  if (pa === "hero-j" || pb === "hero-j") {
    expect(files.get("creatures/jellyfish.js")).toContain('const BELL = "purple"');
  }
}

function checkInterleaving(pa: string, pb: string, k: number, hold: boolean): void {
  const { sim, a, b } = runInterleaving(pa, pb, k, hold);

  if (hold) {
    // B landed while A was parked; nothing lands during B's own run, so B is never sent
    // a heads-up.
    expect(sentTo(sim, b)).toEqual([]);
    checkDisturbance(sim, a, aDisturbance(pa, pb, k));
  } else {
    // A landed first, undisturbed: B is the in-flight attempt, at its own full script
    // position, and its row against `pa` is the disturbance.
    expect(sentTo(sim, a)).toEqual([]);
    checkDisturbance(sim, b, aDisturbance(pb, pa, SCRIPT_LEN[pb] as number));
  }

  // No attempt is left in flight: every one of the pair landed.
  for (const x of [a, b]) expect(sim.state(x)).toBe("landed");
  checkFinalTree(sim, pa, pb);
}

describe("hero interleavings (02-tidepool.md 7, 10.5): a heads-up at every point of every script", () => {
  for (const pa of CAST) {
    for (const pb of CAST) {
      if (pa === pb) continue;
      const len = SCRIPT_LEN[pa] as number;
      for (let k = 0; k <= len; k += 1) {
        // `hold` parks A before its submit once the script reaches it; at k = len the
        // unheld variant instead runs A's submit, so B lands against a `validated` A.
        const holds = k === len ? [true, false] : [true];
        for (const hold of holds) {
          it(`a=${pa} b=${pb} k=${k} ${hold ? "held" : "running"}`, () => {
            checkInterleaving(pa, pb, k, hold);
          });
        }
      }
    }
  }
});
