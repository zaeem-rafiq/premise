// The `add-energy` and `add-relative` canned patterns (02-tidepool.md 10.3): the same tool calls
// as `add-plain`, but the third entity read is `energy#ENERGY_MAX` and the write is template
// T-energy or T-relative of 10.2. The patterns differ in the truth list, the threshold text and
// the row's answer to an `E2` repair on `ENERGY_MAX`: `add-energy` rescales its own threshold and
// acknowledges "rescaled the threshold"; `add-relative` acknowledges with no edit (the designed
// false abort, HU12 `changed: false`). An `info` (X0) on `ENERGY_MAX` before the write gives the
// new value the write must use.
//
// A `write`, `replace` or `submit` sent while an unshown heads-up waits is refused
// `heads_up_first` (TA3): the operation is NOT recorded, and the heads-up arrives on that
// answer. Nothing is replayed blindly — every issued call is computed again at issue time
// from the pattern's freshest knowledge, so the write's threshold always follows `v`
// (the X0/E2 updates land in `v` before the re-issue), a refused repair keeps its queue
// slot, and a name that raced a landing is re-listed before the next write.
//
// Points where the row is silent, answered from the same-file row's spirit and SW6:
// `read_first` on the creature write — the name was taken between the `list` and the
// `write` — re-lists `creatures/` and writes the next free name; a dropped write does
// the same (F1/OP5): relist, rewrite the next free name on the current source, then
// acknowledge. A repair or confirm anywhere else: SW6's defaults.

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import {
  energyMaxOf,
  fileNamesOf,
  freshName,
  sourceOf,
  submitFields,
  submitStatus,
  thresholdText,
} from "../scripted.ts";
import { PALETTE, tEnergy, tRelative } from "../templates.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

/** The entity a scripted `read` names, in the order of the row's call list (02 10.3). */
const READ_ENTITIES: ReadonlyArray<{ path: string; entity: string }> = [
  { path: "world/bounds.js", entity: "bounce" },
  { path: "world/movement.js", entity: "step" },
  { path: "world/energy.js", entity: "ENERGY_MAX" },
];

/** Script positions: 0 `list`, 1 `read GUIDE.md`, 2 to 4 the entity reads, 5 `write`, 6 `submit`. */
const STEP_LIST = 0;
const STEP_ENERGY_READ = 4;
const STEP_WRITE = 5;
const STEP_SUBMIT = 6;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "relist" | "repair" | "submit";

type AddEnergyState = {
  issued: Issued;
  step: number;
  entries: string[];
  name: string | null;
  colour: string | null;
  v: number | null; // ENERGY_MAX as last seen: its own read, or a heads-up's `after` (X0, E2)
  threshold: string | null; // the threshold text the attempt's file holds (set when a write is ok)
  pending: string | null; // the threshold text of the write in flight; becomes `threshold` on ok
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  repairs: Array<{ path: string; old: string; new: string }>; // queued `replace`s; the head is in flight
  relist: boolean; // the creature name raced a landing: list again, then write the next free name
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): AddEnergyState {
  return {
    issued: "none",
    step: STEP_LIST,
    entries: [],
    name: null,
    colour: null,
    v: null,
    threshold: null,
    pending: null,
    seen_hns: [],
    repairs: [],
    relist: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/** The knobs that turn this script into `add-energy` or `add-relative` (02 10.3, the two rows). */
type AddEnergyOpts = {
  id: string;
  intent: string;
  truth: readonly string[];
  /** T-relative instead of T-energy (the threshold text `ENERGY_MAX * 0.3`, no number). */
  relative: boolean;
  /** `add-energy` rescales its threshold on an `E2`; `add-relative` acknowledges with no edit. */
  rescaleOnE2: boolean;
};

/**
 * The heads-up answers of the row and SW6.
 * `info` (X0) on `ENERGY_MAX`: take the new `V` from `after`; the not-yet-made write uses it.
 * `repair` (E2) on `ENERGY_MAX`: `add-energy` queues the threshold `replace`, chained off the
 * queue's tail so consecutive E2s stay consistent; `add-relative` acknowledges with no edit.
 * `confirm` and any other `repair`: acknowledge "not affected". A dropped write: the file is
 * gone — re-list and write the next free name on the current source (F1/OP5), then acknowledge.
 */
function answerHeadsUp(opts: AddEnergyOpts, state: AddEnergyState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") {
    for (const item of headsUp.items) {
      if (item.premise.kind === "entity" && item.premise.key === ENERGY_KEY && item.diff.kind === "entity") {
        const v = energyMaxOf(item.diff.after);
        if (v !== null) state.v = v;
      }
    }
    return;
  }
  let statement = "not affected";
  if (headsUp.result === "repair" && opts.rescaleOnE2) {
    for (const item of headsUp.items) {
      if (
        item.rule === "E2" &&
        item.result === "repair" &&
        item.premise.kind === "entity" &&
        item.premise.key === ENERGY_KEY &&
        item.diff.kind === "entity"
      ) {
        const v = energyMaxOf(item.diff.after);
        if (v !== null) {
          state.v = v;
          const next = thresholdText(v);
          // After its write the threshold is in the file; before it there is nothing to replace.
          // The chain starts from the queue's tail — the file's projected text — so a second
          // E2 that lands before the first replace runs still edits the right `old`.
          const cur = state.repairs.at(-1)?.new ?? state.threshold;
          if (state.name !== null && cur !== null && cur !== next) {
            state.repairs.push({
              path: state.name,
              old: `creature.energy < ${cur}`,
              new: `creature.energy < ${next}`,
            });
          }
          statement = "rescaled the threshold";
        }
      }
    }
  }
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    // The dropped op is the creature write (the only write the pattern makes): the file is
    // gone, pending threshold replaces are moot — the fresh write carries the current value —
    // and the name is listed fresh.
    state.repairs.length = 0;
    state.threshold = null;
    state.name = null;
    state.relist = true;
    statement = "reapplied the edit";
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: AddEnergyState, turn: PatternTurn): void {
  const last = turn.last;
  if (last === null || state.issued === "none") return;
  const issued = state.issued;
  state.issued = "none";
  if (last.error !== undefined) {
    const code = last.error.code;
    if (code === "attempt_closed" || code === "attempt_unknown") {
      state.done = true;
    } else if (code === "heads_up_first") {
      // TA3: the call was refused without being recorded; the heads-ups that caused it ride
      // this answer and the step is decided again below, never replayed.
    } else if (code === "read_first" && issued === "script" && state.step === STEP_WRITE) {
      // The creature name was taken between `list` and `write`: re-list, then write the
      // next free name (the same-file row's answer, generalized).
      state.relist = true;
      state.name = null;
    } else {
      // SW6: a call answering `limit_reached`, `no_match` or `ambiguous`, and any other failure the
      // script cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    state.pending = null;
    return;
  }
  if (issued === "script") {
    if (state.step === STEP_LIST) state.entries = fileNamesOf(last.result);
    if (state.step === STEP_ENERGY_READ) {
      const v = energyMaxOf(sourceOf(last.result));
      if (v !== null) state.v = v;
    }
    if (state.step === STEP_WRITE) {
      state.threshold = state.pending;
      state.pending = null;
    }
    state.step += 1;
    return;
  }
  if (issued === "relist") {
    state.entries = fileNamesOf(last.result);
    state.name = null;
    state.step = STEP_WRITE;
    state.relist = false;
    return;
  }
  if (issued === "repair") {
    // Confirmed: the queued `replace` at the head is consumed; the file's threshold follows it.
    const done = state.repairs.shift();
    if (done !== undefined && done.path === state.name) state.threshold = done.new;
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

export function makeEnergyAdd(opts: AddEnergyOpts): Pattern {
  return {
    id: opts.id,
    intent: opts.intent,
    truth: opts.truth,

    next(turn: PatternTurn): PatternStep {
      const state: AddEnergyState = turn.state === null ? initialState() : { ...(turn.state as AddEnergyState) };
      state.released ||= turn.released;

      consumeLast(state, turn);
      for (const headsUp of turn.heads_ups) answerHeadsUp(opts, state, headsUp);

      // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
      if (state.done && (state.acks.length > 0 || state.repairs.length > 0 || state.relist)) {
        state.done = false;
        state.step = STEP_SUBMIT;
      }

      if (state.withdrawn) {
        const reason: AgentStopReason = "withdrawn";
        return { kind: "stop", reason, state };
      }
      if (state.repairs.length > 0) {
        // The head stays queued until its answer confirms it — a `heads_up_first` refusal
        // re-issues the same operation, not the next one.
        const repair = state.repairs[0] as { path: string; old: string; new: string };
        state.issued = "repair";
        return { kind: "tool", tool: "replace", args: repair, state };
      }
      if (state.relist) {
        state.issued = "relist";
        return { kind: "tool", tool: "list", args: { path: "creatures/" }, state };
      }
      if (state.done) return { kind: "wait", state };

      if (state.step === STEP_LIST) {
        state.issued = "script";
        return { kind: "tool", tool: "list", args: { path: "creatures/" }, state };
      }
      if (state.step === 1) {
        state.issued = "script";
        return { kind: "tool", tool: "read", args: { path: "GUIDE.md" }, state };
      }
      if (state.step >= 2 && state.step <= 4) {
        state.issued = "script";
        const entity = READ_ENTITIES[state.step - 2] as { path: string; entity: string };
        return { kind: "tool", tool: "read", args: entity, state };
      }
      if (state.step === STEP_WRITE) {
        if (state.name === null) {
          state.name = freshName(state.entries);
          // The colour is the script's one draw of the agent's stream (SW1).
          state.colour = PALETTE[Math.floor(turn.rand() * PALETTE.length)] as string;
        }
        // The threshold is computed at every issue — a refused write re-decides with the
        // `v` the heads-up that refused it carried (X0: the escape of 2026-10-04).
        const threshold = opts.relative ? "ENERGY_MAX * 0.3" : thresholdText(state.v ?? 100);
        state.pending = threshold;
        state.issued = "script";
        const content = opts.relative ? tRelative(state.colour as string) : tEnergy(state.colour as string, threshold);
        return {
          kind: "tool",
          tool: "write",
          args: { path: state.name, content },
          state,
        };
      }

      // STEP_SUBMIT. SW8/SWR3: a held agent waits before its first submit until released.
      if (turn.hold && !state.released) return { kind: "wait", state };
      state.issued = "submit";
      return {
        kind: "tool",
        tool: "submit",
        args: { summary: opts.intent, ...submitFields(state.acks) },
        state,
      };
    },
  };
}

export const ADD_ENERGY: Pattern = makeEnergyAdd({
  id: "add-energy",
  intent: "add a creature",
  truth: ["entity:world/energy.js#ENERGY_MAX", "entity:world/bounds.js#bounce", "entity:world/movement.js#step"],
  relative: false,
  rescaleOnE2: true,
});
