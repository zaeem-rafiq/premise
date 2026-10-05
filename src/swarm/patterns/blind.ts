// The `blind` canned pattern (02-tidepool.md 10.3): `read` `GUIDE.md`; `write` T-plain to a
// drawn fresh name; `submit`. It never reads the entities its file references (`bounce`,
// `step`, `wander`), so its first `submit` lands the blind-spot `confirm` of B1: it answers
// "not affected" and submits again (the row; SW6's `confirm` default). It measures the cost of
// blind spots (10.4).
//
// The name is a draw from a high range (`s` + five digits), outside the sequential names
// `freshName` gives `add-plain`-family patterns, so two blind agents' files do not meet except
// in a long run. A `repair` (F1, with OP5) that drops the write — or `read_first` on it — draws
// the name again and writes the same file under it (the row's "as `retune`"-silent points take
// SW6's reapply). `info` does nothing; a `repair` without a dropped operation acknowledges
// "not affected". Any call answering `limit_reached`, `no_match` or `ambiguous` ends the
// attempt `withdrawn` (SW6, TA9a); a held agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { submitFields, submitStatus } from "../scripted.ts";
import { PALETTE, SPEEDS, tPlain } from "../templates.ts";

/** The drawn fresh name: `s10000` to `s99999`, outside `add-plain`'s sequential range. */
function drawName(rand: () => number): string {
  return `creatures/s${10000 + Math.floor(rand() * 90000)}.js`;
}

/** Script positions: 0 `read GUIDE.md`, 1 `write`, 2 `submit`. */
const STEP_READ = 0;
const STEP_WRITE = 1;
const STEP_SUBMIT = 2;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "submit";

type BlindState = {
  issued: Issued;
  step: number;
  name: string | null;
  colour: string | null;
  speed: number | null;
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): BlindState {
  return {
    issued: "none",
    step: STEP_READ,
    name: null,
    colour: null,
    speed: null,
    seen_hns: [],
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * The heads-up answers of the row and SW6.
 * `confirm` (B1's blind-spot turn at submit): acknowledge "not affected", no edit.
 * `repair` with the write dropped (F1 + OP5): the name is drawn again and the same file is
 * written under it, then acknowledged. `repair` without a dropped operation: "not affected".
 * `info`: nothing.
 */
function answerHeadsUp(state: BlindState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    state.name = null; // the write is gone: draw a fresh name and write the same file again
    state.step = STEP_WRITE;
    statement = "reapplied the edit";
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: BlindState, turn: PatternTurn): void {
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
      // decided again below, never replayed.
    } else if (code === "read_first" && issued === "script" && state.step === STEP_WRITE) {
      // The drawn name was taken between the draw and the write: draw another (SW6's reapply
      // of a write to a fresh name — the row is silent).
      state.name = null;
    } else {
      // SW6: `limit_reached`, `no_match` or `ambiguous`, and any other failure the script
      // cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
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
      state.step = STEP_SUBMIT; // acknowledge the blind-spot `confirm`, then submit again
    } else if (status === "rejected") {
      state.withdrawn = true; // the script cannot fix a rejected change
    } else if (status === "stopped") {
      state.done = true;
    }
  }
}

export const BLIND: Pattern = {
  id: "blind",
  intent: "add a creature",
  truth: ["entity:world/bounds.js#bounce", "entity:world/movement.js#step", "entity:world/movement.js#wander"],

  next(turn: PatternTurn): PatternStep {
    const state: BlindState = turn.state === null ? initialState() : { ...(turn.state as BlindState) };
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
    if (state.done) return { kind: "wait", state };

    if (state.step === STEP_READ) {
      state.issued = "script";
      return { kind: "tool", tool: "read", args: { path: "GUIDE.md" }, state };
    }
    if (state.step === STEP_WRITE) {
      if (state.name === null) {
        state.name = drawName(turn.rand);
        state.colour = PALETTE[Math.floor(turn.rand() * PALETTE.length)] as string;
        state.speed = SPEEDS[Math.floor(turn.rand() * SPEEDS.length)] as number;
      }
      state.issued = "script";
      return {
        kind: "tool",
        tool: "write",
        args: { path: state.name, content: tPlain(state.colour as string, state.speed as number) },
        state,
      };
    }

    // STEP_SUBMIT. SW8/SWR3: a held agent waits before its first submit until released.
    if (turn.hold && !state.released) return { kind: "wait", state };
    state.issued = "submit";
    return {
      kind: "tool",
      tool: "submit",
      args: { summary: BLIND.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
