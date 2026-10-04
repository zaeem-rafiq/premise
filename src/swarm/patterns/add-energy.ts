// The `add-energy` and `add-relative` canned patterns (02-tidepool.md 10.3): the same tool calls
// as `add-plain`, but the third entity read is `energy#ENERGY_MAX` and the write is template
// T-energy or T-relative of 10.2. The patterns differ in the truth list, the threshold text and
// the row's answer to an `E2` repair on `ENERGY_MAX`: `add-energy` rescales its own threshold and
// acknowledges "rescaled the threshold"; `add-relative` acknowledges with no edit (the designed
// false abort, HU12 `changed: false`). An `info` (X0) on `ENERGY_MAX` before the write gives the
// new value the write must use. Everything else takes the defaults of SW6; a held agent waits
// before its first `submit` (SW8, SWR3).

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
type Issued = "none" | "script" | "repair" | "rewrite" | "submit";

type AddEnergyState = {
  issued: Issued;
  step: number;
  entries: string[];
  name: string | null;
  colour: string | null;
  v: number | null; // ENERGY_MAX as last seen: its own read, or a heads-up's `after` (X0, E2)
  threshold: string | null; // the threshold text its write used, updated by every E2 repair
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  repairs: Array<{ path: string; old: string; new: string }>; // the row's `replace` calls (E2)
  rewrite: boolean; // a dropped write to apply again (SW6)
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
    seen_hns: [],
    repairs: [],
    rewrite: false,
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
 * `repair` (E2) on `ENERGY_MAX`: `add-energy` queues the threshold `replace`; `add-relative`
 * acknowledges with no edit. `confirm` and any other `repair`: acknowledge "not affected".
 * A dropped operation: apply the write again, then acknowledge (SW6).
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
          if (state.name !== null && state.threshold !== null && state.threshold !== next) {
            state.repairs.push({
              path: state.name,
              old: `creature.energy < ${state.threshold}`,
              new: `creature.energy < ${next}`,
            });
          }
          state.threshold = next;
          statement = "rescaled the threshold";
        }
      }
    }
  }
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    state.rewrite = true;
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
      // The submit was refused for unseen heads-ups; they arrive and are answered, then it retries.
    } else {
      // SW6: a call answering `limit_reached`, `no_match` or `ambiguous`, and any other failure the
      // script cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
    if (state.step === STEP_LIST) state.entries = fileNamesOf(last.result);
    if (state.step === STEP_ENERGY_READ) {
      const v = energyMaxOf(sourceOf(last.result));
      if (v !== null) state.v = v;
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
  // "repair" and "rewrite" answers need no bookkeeping: the acknowledgement was queued at
  // schedule time.
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
      if (state.done && (state.acks.length > 0 || state.repairs.length > 0 || state.rewrite)) {
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
      if (state.rewrite && state.name !== null) {
        state.rewrite = false;
        state.issued = "rewrite";
        const content = opts.relative
          ? tRelative(state.colour as string)
          : tEnergy(state.colour as string, state.threshold as string);
        return { kind: "tool", tool: "write", args: { path: state.name, content }, state };
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
          state.threshold = opts.relative ? "ENERGY_MAX * 0.3" : thresholdText(state.v ?? 100);
        }
        state.issued = "script";
        const content = opts.relative
          ? tRelative(state.colour as string)
          : tEnergy(state.colour as string, state.threshold as string);
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
