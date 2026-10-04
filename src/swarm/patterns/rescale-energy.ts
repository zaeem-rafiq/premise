// The `rescale-energy` canned pattern (02-tidepool.md 10.3): `read` `energy#ENERGY_MAX`, `replace`
// `ENERGY_MAX = 100` with `ENERGY_MAX = 1` or the reverse (whichever applies). The `replace`
// result names in `relied_on_by` every referrer of `ENERGY_MAX` at that head (01-core.md D2): for
// each one that is a creature module it `read`s the `update` entity, and when that source holds
// the T-energy line with a number it `replace`s the number with `0.3 x new V` — a creature that
// landed the absolute threshold before the rescale is repaired by the rescale's own change, so no
// interleaving strands it (SW2). Then `submit`.
//
// A `repair` (QR1) means a creature landed referencing `ENERGY_MAX` while the rescale was in
// flight: for each module that gained a referrer it takes the `update` entity from the item
// (`added` or `context`), and when that source holds the T-energy line with a number it
// `replace`s the number with `0.3 x new V`, then acknowledges. A module named by `relied_on_by`
// and again by a QR1 is repaired once, not twice. A `repair` (E1, with OP1) means another rescale
// landed first: `stop` `withdrawn`. Everything else takes the defaults of SW6; a held agent waits
// before its first `submit` (SW8, SWR3).
//
// A `replace` or `submit` sent while an unshown heads-up waits is refused `heads_up_first` (TA3):
// the operation is NOT recorded, and the heads-up arrives on that answer. Queued repairs keep
// their slot until confirmed, so a refused one is re-issued rather than skipped; a queued
// referrer read is re-issued the same way — decided again, never replayed.
//
// Points where the row is silent, answered from the row's spirit and SW6: an `info` (X0) on
// `ENERGY_MAX` before the `replace` — another rescale landed between the read and the replace, so
// `own` no longer matches the file — re-decides the step from the fresh value the item's `after`
// carries ("whichever applies"), instead of replaying the stale `old` into a `no_match`. And a
// dropped operation on a creature module (OP6) is applied again on the current source: the
// `update` entity is re-read and the threshold line re-derived, not replayed against bytes that
// changed underneath.

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp, HeadsUpItem } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import {
  energyMaxOf,
  readArgsOf,
  sourceOf,
  submitFields,
  submitStatus,
  thresholdText,
} from "../scripted.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

/** The T-energy threshold line with a number (`creature.energy < 30`), capture = the number. */
const T_ENERGY_LINE = /creature\.energy\s*<\s*(\d+(?:\.\d+)?)/;

/** A creature module: one file directly in `creatures/` (TP7: `creatures/<kind>.js`). */
const CREATURE_MODULE = /^creatures\/[^/]+\.js$/;

/** Script positions: 0 `read`, 1 `replace`, 2 `submit`. The referrer reads ride `visit`. */
const STEP_READ = 0;
const STEP_REPLACE = 1;
const STEP_SUBMIT = 2;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "visit" | "repair" | "submit";

type RescaleState = {
  issued: Issued;
  step: number;
  v: number | null; // ENERGY_MAX as last seen: its own read, or a heads-up's `after` (X0)
  own: { old: string; new: string } | null; // its `ENERGY_MAX` replace args, re-derived from `v`
  newV: number | null; // the value it is landing; `0.3 x newV` is the repair's threshold
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  visit: string[]; // `<module>#update` keys `relied_on_by` named, still to `read` (the head is in flight)
  repairs: Array<{ path: string; old: string; new: string }>; // queued `replace`s; the head is in flight
  repaired: string[]; // creature module paths whose threshold repair was queued — once each
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): RescaleState {
  return {
    issued: "none",
    step: STEP_READ,
    v: null,
    own: null,
    newV: null,
    seen_hns: [],
    visit: [],
    repairs: [],
    repaired: [],
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/** The path part of an entity key (`creatures/s0004.js#update` -> `creatures/s0004.js`). */
function pathOf(key: string): string {
  const cut = key.indexOf("#");
  return cut < 0 ? key : key.slice(0, cut);
}

/** The row's "or the reverse, whichever applies": the replace a fresh `V` asks for, or null
 * when neither side of the canned flip applies. */
function flipOf(v: number): { own: { old: string; new: string }; newV: number } | null {
  if (v === 100) return { own: { old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" }, newV: 1 };
  if (v === 1) return { own: { old: "ENERGY_MAX = 1", new: "ENERGY_MAX = 100" }, newV: 100 };
  return null;
}

/** The referrer keys `relied_on_by` names for `ENERGY_MAX` in a `write`/`replace` result (D2). */
function reliedOnBy(result: object | undefined): string[] {
  const map = (result as { relied_on_by?: unknown } | undefined)?.relied_on_by;
  if (typeof map !== "object" || map === null) return [];
  const keys = (map as Record<string, unknown>)[ENERGY_KEY];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

/** The `replace` that turns the captured T-energy line's number into `0.3 x newV`, or null when
 * the threshold already reads so (a same-text rewrite would fail `no_change`). */
function thresholdEdit(match: RegExpExecArray, newV: number): { old: string; new: string } | null {
  const next = match[0].replace(match[1] as string, thresholdText(newV));
  return next === match[0] ? null : { old: match[0], new: next };
}

/** Queue the threshold `replace` for `path` when `source` holds the T-energy line with a number.
 * The module is marked so a referrer named twice — by `relied_on_by` and a QR1, or by two items —
 * is repaired once. */
function queueRepair(state: RescaleState, path: string, source: string | null): void {
  if (state.repaired.includes(path) || state.newV === null) return;
  const match = source === null ? null : T_ENERGY_LINE.exec(source);
  if (match === null) return;
  const edit = thresholdEdit(match, state.newV);
  if (edit === null) return;
  state.repaired.push(path);
  state.repairs.push({ path, ...edit });
}

/**
 * The QR1 repair of the row: for each module that gained a referrer, the `update` entity from
 * the item's `added` or `context`; when its source holds the T-energy line with a number, a
 * `replace` of the number with `0.3 x newV`. No read is needed.
 */
function qr1Repairs(state: RescaleState, item: HeadsUpItem): void {
  if (item.diff.kind !== "query") return;
  const members = [...item.diff.added, ...item.diff.context];
  const modules = [...new Set(item.diff.added.map((m) => pathOf(m.key)))];
  for (const module of modules) {
    const update = members.find((m) => m.key === `${module}#update`);
    queueRepair(state, module, update === undefined ? null : (update.source ?? null));
  }
}

/**
 * The heads-up answers of the row and SW6.
 * `info` (X0) on `ENERGY_MAX`: the row is silent — the fresh `after` re-derives the replace the
 * row names ("whichever applies"), so the refused `replace` is re-decided, not replayed.
 * `repair` (E1) on `ENERGY_MAX`: another rescale landed first -> `stop` `withdrawn`.
 * `repair` (QR1): the gained-module `replace`s, then acknowledge "rescaled the threshold".
 * `confirm` and any other `repair`: acknowledge "not affected"; a dropped operation is applied
 * again on the current source — its own `replace` for `world/energy.js`, a fresh `read` of the
 * module's `update` for a dropped creature repair — then acknowledged (SW6).
 */
function answerHeadsUp(state: RescaleState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") {
    for (const item of headsUp.items) {
      if (item.premise.kind === "entity" && item.premise.key === ENERGY_KEY && item.diff.kind === "entity") {
        const v = energyMaxOf(item.diff.after);
        if (v === null) continue;
        state.v = v;
        const flip = flipOf(v);
        if (flip === null) {
          state.withdrawn = true; // neither side of the canned flip applies
          return;
        }
        state.own = flip.own;
        state.newV = flip.newV;
      }
    }
    return;
  }
  if (
    headsUp.result === "repair" &&
    headsUp.items.some(
      (item) =>
        item.rule === "E1" &&
        item.result === "repair" &&
        item.premise.kind === "entity" &&
        item.premise.key === ENERGY_KEY,
    )
  ) {
    state.withdrawn = true; // the row: another rescale landed first; `stop` with `withdrawn`.
    return;
  }
  let statement = "not affected";
  if (headsUp.result === "repair") {
    for (const item of headsUp.items) {
      if (item.rule === "QR1" && item.result === "repair") {
        const before = state.repairs.length;
        qr1Repairs(state, item);
        if (state.repairs.length > before) statement = "rescaled the threshold";
      }
    }
    for (const dropped of headsUp.dropped_ops) {
      if (dropped.path === "world/energy.js" && state.own !== null) {
        state.repairs.push({ path: "world/energy.js", old: state.own.old, new: state.own.new });
        statement = "reapplied the edit";
      } else if (CREATURE_MODULE.test(dropped.path)) {
        // A repair whose `replace` no longer applies (OP1: another change landed first) is
        // applied again on the current source — the `update` entity is re-read, and the
        // queue may repair it once more.
        const key = `${dropped.path}#update`;
        state.repaired = state.repaired.filter((p) => p !== dropped.path);
        if (!state.visit.includes(key)) state.visit.push(key);
        statement = "reapplied the edit";
      }
    }
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: RescaleState, turn: PatternTurn): void {
  const last = turn.last;
  if (last === null || state.issued === "none") return;
  const issued = state.issued;
  state.issued = "none";
  if (last.error !== undefined) {
    const code = last.error.code;
    if (code === "attempt_closed" || code === "attempt_unknown") {
      state.done = true;
    } else if (code === "heads_up_first") {
      // TA3: refused without being recorded; the heads-ups ride this answer and the step is
      // decided again below, never replayed. A queued read or `replace` keeps its slot.
    } else if (issued === "visit" && (code === "not_found" || code === "not_a_module")) {
      state.visit.shift(); // the referrer vanished or its file is opaque: nothing to repair
    } else {
      // SW6: a call answering `limit_reached`, `no_match` or `ambiguous`, and any other failure the
      // script cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
    if (state.step === STEP_READ) {
      const v = energyMaxOf(sourceOf(last.result));
      state.v = v;
      const flip = v === null ? null : flipOf(v);
      if (flip === null) {
        state.withdrawn = true; // neither applies: the rescale has nothing to replace
        return;
      }
      state.own = flip.own;
      state.newV = flip.newV;
    }
    if (state.step === STEP_REPLACE) {
      // D2: the recorded `replace` names the referrers of `ENERGY_MAX` at this head. Each
      // creature module among them is visited once — the `read` of its `update` decides
      // whether the row's `replace` is queued.
      for (const key of reliedOnBy(last.result)) {
        const path = pathOf(key);
        if (!CREATURE_MODULE.test(path)) continue;
        const updateKey = `${path}#update`;
        if (!state.visit.includes(updateKey) && !state.repaired.includes(path)) {
          state.visit.push(updateKey);
        }
      }
    }
    state.step += 1;
    return;
  }
  if (issued === "visit") {
    const key = state.visit.shift();
    if (key !== undefined) queueRepair(state, pathOf(key), sourceOf(last.result));
    return;
  }
  if (issued === "repair") {
    state.repairs.shift(); // the confirmed `replace` leaves the queue
    return;
  }
  if (issued === "submit") {
    const status = submitStatus(last.result);
    if (
      status === "validated" ||
      status === "submitted" ||
      status === "held" ||
      status === "accepted" ||
      status === "landed"
    ) {
      state.acks = [];
      state.done = true;
    } else if (status === "needs_confirm" || status === "go_around") {
      state.step = STEP_SUBMIT; // answer the waiting heads-ups, then submit again
    } else if (status === "rejected") {
      state.withdrawn = true; // the script cannot fix a rejected change
    } else if (status === "stopped") {
      state.done = true;
    }
  }
}

export const RESCALE_ENERGY: Pattern = {
  id: "rescale-energy",
  intent: "rescale ENERGY_MAX",
  truth: ["entity:world/energy.js#ENERGY_MAX", "query:refs:world/energy.js#ENERGY_MAX"],

  next(turn: PatternTurn): PatternStep {
    const state: RescaleState = turn.state === null ? initialState() : { ...(turn.state as RescaleState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    if (state.done && (state.acks.length > 0 || state.repairs.length > 0 || state.visit.length > 0)) {
      state.done = false;
      state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.repairs.length > 0) {
      const repair = state.repairs[0] as { path: string; old: string; new: string };
      state.issued = "repair";
      return { kind: "tool", tool: "replace", args: repair, state };
    }
    // The referrers of `relied_on_by` (D2): `read` each creature module's `update`. A module a
    // QR1 heads-up already repaired is skipped — the referrer is repaired once, not twice.
    while (state.visit.length > 0 && state.repaired.includes(pathOf(state.visit[0] as string))) {
      state.visit.shift();
    }
    if (state.visit.length > 0) {
      state.issued = "visit";
      return { kind: "tool", tool: "read", args: readArgsOf(state.visit[0] as string), state };
    }
    if (state.done) return { kind: "wait", state };

    if (state.step === STEP_READ) {
      state.issued = "script";
      return { kind: "tool", tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" }, state };
    }
    if (state.step === STEP_REPLACE && state.own !== null) {
      state.issued = "script";
      return {
        kind: "tool",
        tool: "replace",
        args: { path: "world/energy.js", old: state.own.old, new: state.own.new },
        state,
      };
    }

    // STEP_SUBMIT. SW8/SWR3: a held agent waits before its first submit until released.
    if (turn.hold && !state.released) return { kind: "wait", state };
    state.issued = "submit";
    return {
      kind: "tool",
      tool: "submit",
      args: { summary: RESCALE_ENERGY.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
