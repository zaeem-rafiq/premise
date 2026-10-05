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

/** The heads-ups a landing sent `agent` — a disturbance. `blind` and `same-file` take a B1
 * `confirm` of their own submit (cause `submit`): it is their own blind spot, not a landing's
 * disturbance, and the cells below count only landing-caused heads-ups. */
function landingSentTo(sim: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return sentTo(sim, agent).filter((e) => (e.cause as { type?: string } | undefined)?.type === "landing");
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
  // The seven new rows of 10.3: retune and edit-creature are read/replace/submit; the sweeps
  // list-and-read then edit each swept file; reader is the wide read plus `add-plain`'s six;
  // same-file and blind resubmit once for the B1 `confirm` their write is owed (10.3).
  retune: 3,
  "edit-creature": 3,
  "sweep-colour": 10,
  "sweep-search": 8,
  "same-file": 3,
  reader: 8,
  blind: 4,
};

/** Fixed draw positions for the patterns whose first `rand` picks a target (SW1): retune's
 * agent 0 draws pick 2 of 4 (`energy#REST_TICKS`), edit-creature's agent 5 draws pick 0
 * (`creatures/s0000.js`), and a `same-file` pair shares one stream — agent 4 draws
 * `creatures/d8742.js`. Every other pattern's draws do not move a collision row, so it keeps
 * the harness default (its position in the cast). */
const FIXED_N: Record<string, number> = { retune: 0, "edit-creature": 5, "same-file": 4 };

/** Patterns whose landing adds a file to `creatures/` (any landing that adds a creature file
 * trips the sweep's `listing` premise — L1, or L3 + the late-L1 when the sweep begins). */
const ADDS_FILE = new Set(["add-plain", "add-energy", "add-relative", "same-file", "reader", "blind"]);

/** Patterns whose landing adds a `wander(creature, 0.05)` container (a T-plain file): the
 * `sweep-search` query rows X0/QT2/QT1 hang on these, not on T-energy or T-relative. */
const ADDS_CONTAINER = new Set(["add-plain", "same-file", "reader", "blind"]);

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
  // The seven new rows of 10.3: each against `rescale-energy` and against each sweep, the
  // table's named self-pairs, and the QR4 reader rows (A22).
  ["retune", "rescale-energy"], // E2m + QR1m confirm both ways once the replace is recorded
  ["retune", "retune"], // the same constant twice: E1 + OP1, re-derived and landed
  ["retune", "sweep-colour"], // nothing either way (no shared premise)
  ["retune", "sweep-search"], // nothing either way
  ["retune", "reader"], // the reader's F4 -> holds info; QR4 the other way holds -> info
  ["edit-creature", "rescale-energy"], // nothing either way
  ["edit-creature", "sweep-colour"], // A22: E2m + QR1m confirm both ways on s0000
  ["edit-creature", "sweep-search"], // QR1m into edit-creature; E2m into the sweep
  ["edit-creature", "edit-creature"], // the same file twice: E1 + OP1, re-derived and landed
  ["sweep-colour", "rescale-energy"], // QR1m into the rescale; E2m into the sweep once fish/minnow are repainted
  ["sweep-colour", "sweep-search"], // E2m/QR1m confirms across the shared s0000
  ["sweep-colour", "sweep-colour"], // two repaints of the first four: F4 info, then E1 + OP1
  ["sweep-search", "rescale-energy"], // nothing either way
  ["sweep-search", "sweep-search"], // QT3 silent, X0 info, E1 + OP1 -> the verbatim re-issue no_match
  ["same-file", "rescale-energy"], // nothing either way (no ENERGY_MAX in T-plain)
  ["same-file", "sweep-colour"], // L1: the added d-file joins the sweep
  ["same-file", "sweep-search"], // the gained container: X0/QT2 info, QT1 repair
  ["same-file", "same-file"], // the pair: F1 + OP5, the next free name lands
  ["reader", "rescale-energy"], // F4/X0 info into the reader; QR4 triage the other way
  ["reader", "sweep-colour"], // L1: the reader's landed file joins the sweep
  ["reader", "sweep-search"], // QT1: a T-plain container is gained
  ["blind", "rescale-energy"], // nothing either way
  ["blind", "sweep-colour"], // L1
  ["blind", "sweep-search"], // QT1
  ["add-plain", "sweep-colour"], // the row's "any add-*" against a listed sweep (L3 -> late L1)
  ["add-plain", "sweep-search"], // a gained T-plain container
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
  if (pa === "add-plain") {
    // Its premises never name a swept entity: a sweep-colour landing alters creatures it did
    // not list by name (L0 — the listing's members do not change), a sweep-search alters the
    // `update` entities of files it never read. Nothing lands on its fresh file.
    return "none";
  }
  if (pa === "retune") {
    // retune of `energy#REST_TICKS` (agent 0's draw): its premises are the entity, then —
    // from the replace — `refs:` and the derived entity premises of energy.js.
    if (pb === "retune") return k === 0 ? "none" : k === 1 ? "info" : "repair"; // E3->X0, E1+OP1
    if (pb === "rescale-energy") {
      // ENERGY_MAX is a derived premise from the replace (energy.js's liveOneTick names it)
      // and energy.js holds referrers of REST_TICKS: E2m + QR1m `confirm`.
      return k <= 1 ? "none" : "confirm";
    }
    if (pb === "reader") {
      // QR4 on `refs:world/energy.js#REST_TICKS`: the reader landed having only read
      // energy.js. Both lists miss the `query:` key — the receiver's names the entity —
      // so the answer is `holds` either way, sent as `info` (the row's re-affirmation).
      return k <= 1 ? "none" : "info";
    }
    return "none"; // sweeps and adders never touch energy.js; edit-creature touches s0000
  }
  if (pa === "edit-creature") {
    // edit-creature of `s0000` (agent 5's draw): entity:#SPEED, then `refs:` + derived.
    if (pb === "edit-creature") return k === 0 ? "none" : k === 1 ? "info" : "repair";
    if (pb === "sweep-colour" || pb === "sweep-search") {
      // The landing alters s0000 (its BODY or its update — neither is SPEED): the entity
      // premise holds (E0) but the derived premise on s0000#BODY (draw references it) flips
      // E2m, and `refs:#SPEED` flips QR1m — s0000's module holds spawn, a referrer of SPEED.
      return k <= 1 ? "none" : "confirm";
    }
    return "none"; // rescale/retune land on world files; adders add a different path
  }
  if (pa === "sweep-colour") {
    // A landing that adds a creature file breaks `listing:creatures/`: L1 when the sweep is
    // already running (its second replace recorded), L3 + the late-L1 when it is not — one
    // `repair` either way, before or at the submit.
    if (ADDS_FILE.has(pb)) return k === 0 ? "none" : "repair";
    if (pb === "sweep-colour") {
      // The twin repaints the same four files: file premises trip F4 -> `info` while only
      // reads stand; once its own replaces are recorded they are dropped (E1 + OP1).
      return k <= 1 ? "none" : k <= 5 ? "info" : "repair";
    }
    if (pb === "sweep-search" || pb === "edit-creature") {
      // Both alter s0000 — update or SPEED, never BODY. The `file:creatures/s0000.js`
      // premise (from the read at call 5) is F4 -> holds `info` until the sweep's own s0000
      // replace is recorded (call 9); then ModuleRefs makes it F3m and refs:BODY flips QR1m.
      return k <= 4 ? "none" : k <= 8 ? "info" : "confirm";
    }
    if (pb === "rescale-energy") {
      // The rescale alters ENERGY_MAX: a derived premise once fish.js's or minnow.js's
      // replace is recorded (their spawn entities reference it) — E2m `confirm` from call 7.
      return k <= 6 ? "none" : "confirm";
    }
    return "none"; // retune lands on energy.js; cosmetic rewords a comment of it (F2)
  }
  if (pa === "sweep-search") {
    if (ADDS_CONTAINER.has(pb)) {
      // A landed T-plain adds a container: QT2 -> X0 `info` before its first recorded edit,
      // QT2 -> triage `repair` with one swept container, QT1 `repair` from the second on.
      return k === 0 ? "none" : k <= 4 ? "info" : "repair";
    }
    if (pb === "sweep-search") {
      // The twin widens the same three containers: the query loses them (QT3, silent) and
      // the read or edit entity premises trip E3 -> X0 `info` or E1 + OP1 `repair`.
      return k <= 1 ? "none" : k <= 4 ? "info" : "repair";
    }
    if (pb === "sweep-colour" || pb === "edit-creature") {
      // The landing alters s0000's BODY or SPEED — entities the sweep's own s0000 replace
      // made derived premises of (ModuleRefs): E2m `confirm` from the first replace on.
      return k <= 4 ? "none" : "confirm";
    }
    return "none"; // rescale, retune and T-energy/T-relative adders leave no match behind
  }
  if (pa === "same-file") {
    // Its partner lands the same `creatures/d<number>.js` first: F1 + OP5 on the write —
    // the pair draws the same name because it shares one stream (n = 4).
    if (pb === "same-file") return k === 0 ? "none" : "repair";
    return "none"; // nobody else lands on its drawn `d` name
  }
  if (pa === "reader") {
    // A landing on `world/energy.js` (rescale, retune of REST_TICKS) breaks the wide file
    // read: X0 `info` before the write, F4 -> scripted `holds` `info` after it — the file is
    // not in the truth list (10.3's reader row).
    if (pb === "rescale-energy" || pb === "retune") return k === 0 ? "none" : "info";
    return "none"; // listings only gain names (L3, silent); creatures it names stay put
  }
  if (pa === "blind") return "none"; // GUIDE.md and its drawn name are never in a landing
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
  if (pb === "retune") {
    // The retune lands on REST_TICKS in energy.js: once the rescale's `replace` pinned
    // `refs:world/energy.js#ENERGY_MAX` and the derived entity premise, E2m + QR1m confirm
    // (A22's first row). The entity premise itself is untouched (E0) and before the replace
    // there is no `refs:` premise at all.
    return k <= 1 ? "none" : "confirm";
  }
  if (pb === "sweep-colour") {
    // fish.js and minnow.js hold `spawn` referrers of ENERGY_MAX; repainting their BODY
    // constants alters those modules: QR1m `confirm` once the `refs:` premise stands.
    return k <= 1 ? "none" : "confirm";
  }
  if (pb === "reader") {
    // QR4: a landing that only read `world/energy.js` lands while the rescale alters
    // ENERGY_MAX. TR8 gives the landed change's list — the reader's — which names no
    // `query:` key: `holds`, sent as `info`. The cell is `it.fails`: the engine asks the
    // receiver's list unless an E1 item rides in the batch, and the rescale's list names
    // `query:refs:world/energy.js#ENERGY_MAX`, so it answers `repair`.
    return k <= 1 ? "none" : "info";
  }
  // sweep-search and edit-creature alter creature entities only; same-file and blind add
  // a T-plain (no ENERGY_MAX referrer): QR0/QR2, nothing.
  return "none"; // add-plain lands no referrer (QR0); cosmetic alters no entity (A22)
}

/** How A ends: `withdrawn` for the second rescale (its row), for the sweep-search twin whose
 * fixed-text `replace` answers `no_match` from any position past the search — once the twin's
 * `0.1` stands, the row's edit is already applied (the verbatim re-issue of a dropped `replace`
 * for k >= 5, the first queued `replace` for k = 1..4; both `no_match`, so SW6 withdraws —
 * at k = 0 the post-landing search names the containers still holding `0.05` and it lands) —
 * and for the sweep-colour twin while a repaint derived from a pre-landing read is still
 * queued (the same `no_match`, SW6) — once every replace was recorded and dropped (k = 9, 10)
 * the re-reads re-derive each repaint and it lands. */
function aEnd(pa: string, pb: string, k: number): "landed" | "withdrawn" {
  if (pa === "rescale-energy" && pb === "rescale-energy" && k >= 2) return "withdrawn";
  if (pa === "sweep-search" && pb === "sweep-search" && k >= 1) return "withdrawn";
  if (pa === "sweep-colour" && pb === "sweep-colour" && k >= 2 && k <= 8) return "withdrawn";
  return "landed";
}

function runInterleaving(
  pa: string,
  pb: string,
  k: number,
  hold: boolean,
): { sim: SwarmSim; a: AgentHandle; b: AgentHandle } {
  const sim = new SwarmSim(swarmFiles(), { seed: 7 });
  // A pattern whose first draw picks its target gets the fixed position of GRID_N; the rest
  // keep the cast position (`open`'s default). A `same-file` pair shares one stream.
  const a = sim.open(pa, { hold, ...(FIXED_N[pa] === undefined ? {} : { n: FIXED_N[pa] }) });
  for (let i = 0; i < k; i += 1) sim.step(a);

  const b = sim.open(pb, FIXED_N[pb] === undefined ? {} : { n: FIXED_N[pb] });
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
  const sent = landingSentTo(sim, disturbed);
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
    // sent a landing's heads-up (the table has no row that disturbs the first lander here;
    // its own submit's B1 `confirm` is not a disturbance).
    expect(landingSentTo(sim, b)).toEqual([]);
    checkDisturbance(sim, a, b, aDisturbance(pa, pb, k), aEnd(pa, pb, k));
  } else {
    // A lands first (queue seniority), undisturbed: B is the in-flight attempt now,
    // and its row against pa — at B's own full script position — is the disturbance.
    expect(landingSentTo(sim, a)).toEqual([]);
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

/**
 * The QR4 disagreement (01-core 7.2 row QR4, TR8): the decider is the landed change's list —
 * the reader's, which names no `query:` key, so the scripted answer is `holds` (sent as
 * `info`). The engine asks the receiver's list unless an E1 item rides in the batch
 * (src/core/trunk/tick.ts, the E1 loop before `applyClassification`), and the rescale's list
 * names `query:refs:world/energy.js#ENERGY_MAX`, so it answers `repair`. The cell is
 * `it.fails` — marked where the disturbed attempt is a `rescale-energy` parked behind a
 * landing `reader`, with the `refs:` premise standing (k >= 2, after its `replace`).
 */
function qr4Differs(disturbed: string, landing: string, k: number): boolean {
  return disturbed === "rescale-energy" && landing === "reader" && k >= 2;
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
          // The disturbed attempt is A while it is parked (held); once A ran its script and
          // lands first (running), the parked B is the one the heads-up reaches.
          const runner = (hold ? qr4Differs(pa, pb, k) : qr4Differs(pb, pa, SCRIPT_LEN[pb] as number)) ? it.fails : it;
          runner(name, () => {
            checkInterleaving(pa, pb, k, hold);
          });
        }
      }
    }
  }
});
