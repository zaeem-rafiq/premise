// The `rescale-energy` canned pattern (02-tidepool.md 10.3): `read` `energy#ENERGY_MAX`, `replace`
// `ENERGY_MAX = 100` with `ENERGY_MAX = 1` or the reverse (whichever applies), `submit`.
// A `repair` (QR1) means a creature landed referencing `ENERGY_MAX`: for each module that gained a
// referrer it takes the `update` entity from the item (`added` or `context`), and when that source
// holds the T-energy line with a number it `replace`s the number with `0.3 x new V`, then
// acknowledges. A `repair` (E1, with OP1) means another rescale landed first: `stop` `withdrawn`.
// Everything else takes the defaults of SW6; a held agent waits before its first `submit` (SW8,
// SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp, HeadsUpItem } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { energyMaxOf, sourceOf, submitFields, submitStatus, thresholdText } from "../scripted.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

/** The T-energy threshold line with a number (`creature.energy < 30`), capture = the number. */
const T_ENERGY_LINE = /creature\.energy\s*<\s*(\d+(?:\.\d+)?)/;

/** Script positions: 0 `read`, 1 `replace`, 2 `submit`. */
const STEP_READ = 0;
const STEP_REPLACE = 1;
const STEP_SUBMIT = 2;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "repair" | "submit";

type RescaleState = {
  issued: Issued;
  step: number;
  own: { old: string; new: string } | null; // its `ENERGY_MAX` replace args, for SW6 reapply
  newV: number | null; // the value it is landing; `0.3 x newV` is the QR1 repair's threshold
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  repairs: Array<{ path: string; old: string; new: string }>; // QR1 `replace` calls, then its own
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): RescaleState {
  return {
    issued: "none",
    step: STEP_READ,
    own: null,
    newV: null,
    seen_hns: [],
    repairs: [],
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

/**
 * The QR1 repair of the row: for each module that gained a referrer, the `update` entity from
 * the item's `added` or `context`; when its source holds the T-energy line with a number, a
 * `replace` of the number with `0.3 x newV`. No read is needed.
 */
function qr1Repairs(item: HeadsUpItem, newV: number): Array<{ path: string; old: string; new: string }> {
  if (item.diff.kind !== "query") return [];
  const members = [...item.diff.added, ...item.diff.context];
  const modules = [...new Set(item.diff.added.map((m) => pathOf(m.key)))];
  const repairs: Array<{ path: string; old: string; new: string }> = [];
  for (const module of modules) {
    const update = members.find((m) => m.key === `${module}#update`);
    if (update === undefined) continue;
    const match = T_ENERGY_LINE.exec(update.source ?? "");
    if (match === null) continue;
    repairs.push({
      path: module,
      old: match[0],
      new: match[0].replace(match[1] as string, thresholdText(newV)),
    });
  }
  return repairs;
}

/**
 * The heads-up answers of the row and SW6.
 * `repair` (E1) on `ENERGY_MAX`: another rescale landed first -> `stop` `withdrawn`.
 * `repair` (QR1): the gained-module `replace`s, then acknowledge "rescaled the threshold".
 * `confirm` and any other `repair`: acknowledge "not affected"; a dropped operation is applied
 * again on the current source, then acknowledged (SW6). `info`: nothing.
 */
function answerHeadsUp(state: RescaleState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
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
    if (state.newV !== null) {
      for (const item of headsUp.items) {
        if (item.rule === "QR1" && item.result === "repair") {
          const edits = qr1Repairs(item, state.newV);
          state.repairs.push(...edits);
          if (edits.length > 0) statement = "rescaled the threshold";
        }
      }
    }
    if (headsUp.dropped_ops.length > 0 && state.own !== null) {
      state.repairs.push({ path: "world/energy.js", old: state.own.old, new: state.own.new });
      statement = "reapplied the edit";
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
      // The submit was refused for unseen heads-ups; they arrive and are answered, then it retries.
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
      // The row: `ENERGY_MAX = 100` -> `1`, or the reverse, whichever applies.
      if (v === 100) {
        state.own = { old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" };
        state.newV = 1;
      } else if (v === 1) {
        state.own = { old: "ENERGY_MAX = 1", new: "ENERGY_MAX = 100" };
        state.newV = 100;
      } else {
        state.withdrawn = true; // neither applies: the rescale has nothing to replace
        return;
      }
    }
    state.step += 1;
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
  // A "repair" answer needs no bookkeeping: the acknowledgement was queued at schedule time.
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
    if (state.done && state.acks.length > 0) {
      state.done = false;
      state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.repairs.length > 0) {
      const repair = state.repairs.shift() as { path: string; old: string; new: string };
      state.issued = "repair";
      return { kind: "tool", tool: "replace", args: repair, state };
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
