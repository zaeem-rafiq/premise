// Every interleaving the specification names (02-tidepool.md 10.3, both tables): for each
// ordered pair of the five canned patterns the table or the task names, and for every
// script position `k` of the first agent, agent A runs `k` tool calls, agent B runs to its
// landing, and A finishes (released when held). Expected outcomes are written from the
// specification and never from the engine's output (BP1):
//
//   - the SW2 oracle over the final tree returns an empty list;
//   - each attempt ends `landed`, or `stopped` with the reason the row gives (`withdrawn`
//     for a second rescale); nothing is left in `working`, `going_around` or `validated`;
//   - an attempt the table leaves undisturbed receives no `repair` or `confirm` heads-up;
//     where the table names `info` (X0), `confirm` (E2m) or `repair` (E2, QR1, F1, E1), the
//     heads-up of that result is present;
//   - B, which lands while A is parked, is never disturbed (no heads-up is ever sent to it);
//   - the final `world/energy.js` holds exactly one `const ENERGY_MAX =` line.
//
import { describe, expect, it } from "vitest";
import { sw2Escapes } from "../../../src/swarm/sw2.ts";
import { SwarmSim, swarmFiles, type AgentHandle } from "./harness.ts";

/** Drive one agent until it parks (a `wait` step, a `stop`, or a terminal state). */
function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 30; i += 1) {
    if (!sim.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 30 calls");
}

/** The `headsup.sent` events recorded for `agent`. */
function sentTo(sim: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return sim.eventsOf("headsup.sent").filter((e) => e.attempt_id === agent.id);
}

/** The tool-call count of each pattern's script on the swarm seed (the calls its row lists).
 * `rescale-energy`'s `replace` names fish, minnow and turtle in `relied_on_by` (D2), so the
 * seed row is `read`, `replace`, one `update` read per referrer, `submit` — six calls. */
const SCRIPT_LEN: Record<string, number> = {
  "add-plain": 7,
  "add-energy": 7,
  "add-relative": 7,
  "rescale-energy": 6,
  cosmetic: 3,
};

/** The unordered pairs the two tables of 10.3 name among the five implemented patterns,
 * plus the task's additions (`add-energy` with `add-energy`, `add-plain` with
 * `rescale-energy`, and `cosmetic` with each other pattern); each runs in both orders. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["add-energy", "rescale-energy"], // E2 after the write, X0 before it; QR1 the other way
  ["add-relative", "rescale-energy"], // E2 false abort; QR1 the other way
  ["add-plain", "rescale-energy"], // the table names no break either way: the control pair
  ["rescale-energy", "rescale-energy"], // E1 + OP1: the second rescale withdraws
  ["add-energy", "add-energy"], // the same-file shape: F1 + OP5 on the taken name
  ["cosmetic", "add-plain"], // cosmetic disturbs nobody (E0, F2) either way
  ["cosmetic", "add-energy"],
  ["cosmetic", "add-relative"],
  ["cosmetic", "rescale-energy"], // E2m confirm into cosmetic (A22), nothing the other way
];

/** What the table of 10.3 sends to A when B lands while A has run `k` calls. */
type Disturbance = "none" | "info" | "confirm" | "repair";

function aDisturbance(pa: string, pb: string, k: number): Disturbance {
  if (pa === "cosmetic") {
    // add-* landings never touch world/energy.js; a rescale landing gives F4->X0 `info`
    // before cosmetic's replace is recorded, and the observed E2m `confirm` after it.
    if (pb === "rescale-energy") {
      if (k === 0) return "none";
      return k === 1 ? "info" : "confirm";
    }
    return "none";
  }
  if (pa === "add-plain") return "none"; // its premises never name ENERGY_MAX
  if (pa === "add-energy" || pa === "add-relative") {
    if (pb === "rescale-energy") {
      // The entity premise exists once the entity read ran (k=5); before its write the
      // row is X0 (`info`), after it E2 (`repair`); before the read there is no premise.
      if (k <= 4) return "none";
      return k === 5 ? "info" : "repair";
    }
    // A same-name creature landing breaks the recorded write (F1 + OP5); before the
    // write the listing premise only gains a name it is not sweeping (L3, no heads-up).
    if (pb === "add-energy") return k <= 5 ? "none" : "repair";
    return "none"; // cosmetic and the other add-* rows never disturb it
  }
  // pa === "rescale-energy"
  if (pb === "rescale-energy") {
    if (k === 0) return "none";
    // Read only (no ops): E3 -> X0 `info`. Replace recorded: E1 + OP1 `repair`.
    return k === 1 ? "info" : "repair";
  }
  if (pb === "add-energy" || pb === "add-relative") {
    // The `refs:` premise exists only once the replace is recorded (D2): QR1 `repair`.
    // A referrer that landed before the replace is caught without a heads-up: the
    // `replace` result's `relied_on_by` names it and the row repairs it (D2, SW2).
    return k <= 1 ? "none" : "repair";
  }
  return "none"; // add-plain lands no referrer (QR0); cosmetic alters no entity (A22)
}

/** How A ends: `withdrawn` only for the second rescale whose replace is already recorded. */
function aEnd(pa: string, pb: string, k: number): "landed" | "withdrawn" {
  if (pa === "rescale-energy" && pb === "rescale-energy" && k >= 2) return "withdrawn";
  return "landed";
}

function runInterleaving(
  pa: string,
  pb: string,
  k: number,
  hold: boolean,
): { sim: SwarmSim; a: AgentHandle; b: AgentHandle } {
  const sim = new SwarmSim(swarmFiles(), { seed: 7 });
  const a = sim.open(pa, { hold });
  for (let i = 0; i < k; i += 1) sim.step(a);

  const b = sim.open(pb);
  drive(sim, b);
  sim.land(); // B's accept transaction lands it and pushes the heads-ups (HU5b)

  if (hold) {
    // A was parked at its submit gate (or mid-script): B landed first, A is released
    // and finishes against whatever the heads-up carried.
    expect(sim.state(b)).toBe("landed");
    sim.release(a);
    sim.settle();
  } else {
    // Running: A submitted before B, so A is earlier in the landing queue and lands
    // first. Its landing is the disturbance for the still-parked B, which then finishes.
    expect(sim.state(a)).toBe("landed");
    sim.settle();
  }
  return { sim, a, b };
}

function checkDisturbance(
  sim: SwarmSim,
  disturbed: AgentHandle,
  other: AgentHandle,
  want: Disturbance,
  end: "landed" | "withdrawn",
): void {
  const sent = sentTo(sim, disturbed);
  if (want === "none") {
    expect(sent).toEqual([]);
  } else if (want === "info") {
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) expect(e.result).toBe("info");
  } else {
    expect(sent.some((e) => e.result === want)).toBe(true);
  }
  expect(sim.state(other)).toBe("landed");
  if (end === "withdrawn") {
    expect(sim.state(disturbed)).toBe("stopped");
    expect(sim.attempt(disturbed)?.stop_reason).toBe("withdrawn");
  } else {
    expect(sim.state(disturbed)).toBe("landed");
  }
}

function checkInterleaving(pa: string, pb: string, k: number, hold: boolean): void {
  const { sim, a, b } = runInterleaving(pa, pb, k, hold);

  if (hold) {
    // B landed while A was parked; nothing lands during B's own run, so B is never
    // sent a heads-up (the table has no row that disturbs the first lander here).
    expect(sentTo(sim, b)).toEqual([]);
    checkDisturbance(sim, a, b, aDisturbance(pa, pb, k), aEnd(pa, pb, k));
  } else {
    // A lands first (queue seniority), undisturbed: B is the in-flight attempt now,
    // and its row against pa — at B's own full script position — is the disturbance.
    expect(sentTo(sim, a)).toEqual([]);
    const lenB = SCRIPT_LEN[pb] as number;
    checkDisturbance(sim, b, a, aDisturbance(pb, pa, lenB), aEnd(pb, pa, lenB));
  }

  for (const x of [a, b]) {
    expect(["landed", "stopped"]).toContain(sim.state(x));
  }

  // SW2 and the git-level sanity.
  expect(sw2Escapes(sim.files())).toEqual([]);
  const energy = sim.files().get("world/energy.js") ?? "";
  expect(energy.match(/const ENERGY_MAX\s*=/g) ?? []).toHaveLength(1);
}

describe("interleavings (02-tidepool 10.3): a heads-up at every point of every script", () => {
  for (const [x, y] of PAIRS) {
    for (const [pa, pb] of [
      [x, y],
      [y, x],
    ] as const) {
      const len = SCRIPT_LEN[pa] as number;
      for (let k = 0; k <= len; k += 1) {
        // `hold` parks A at its submit gate once the script reaches it; at k = len the
        // unheld variant instead runs A's submit, so B lands against a `validated` A.
        const holds = k === len ? [true, false] : [true];
        for (const hold of holds) {
          const name = `a=${pa} b=${pb} k=${k} ${hold ? "held" : "running"}`;
          it(name, () => {
            checkInterleaving(pa, pb, k, hold);
          });
        }
      }
    }
  }
});
