// The `same-file` canned pattern (02-tidepool.md 10.3): agents come in pairs — the launcher
// gives both members of a pair the same draw stream, so both `write` T-plain to the same drawn
// name `creatures/d<number>.js` (the number is the agent's first `rand` draw) — then `submit`.
// `truthOf` on a fresh stream names the drawn file: `file:creatures/d<number>.js` (the row).
//
// A `repair` (F1, with OP5) — the partner's landing took the shared name out from under the
// recorded `write`: each agent of the pair writes to its own fresh name `creatures/s-<id>.js`
// (10.3), then acknowledges. `read_first` on the write — the shared name was landed between the
// draw and the call — answers the same way; on the own name it `read`s the file first (W1) and
// writes it again. `info` does nothing; `confirm` (B1's blind-spot turn, or any other) and a
// `repair` without a dropped operation acknowledge "not affected" (SW6). Any call answering
// `limit_reached`, `no_match` or `ambiguous` ends the attempt `withdrawn` (SW6, TA9a); a held
// agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { freshName, submitFields, submitStatus } from "../scripted.ts";
import { PALETTE, SPEEDS, tPlain } from "../templates.ts";

/** The `creatures/d<number>.js` name of draw `u` — zero-padded to at least 4 digits. */
function dNameOf(u: number): string {
  return `creatures/d${String(Math.floor(u * 10000)).padStart(4, "0")}.js`;
}

/** Script positions: 0 `write`, 1 `submit`. */
const STEP_WRITE = 0;
const STEP_SUBMIT = 1;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "reshow" | "submit";

type SameFileState = {
  issued: Issued;
  step: number;
  name: string | null; // the drawn `d<number>` name, then the agent's own `s-<id>` after a repair
  colour: string | null;
  speed: number | null;
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  reshow: boolean; // the own-name write answered `read_first`: read the file shown (W1), then write again
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): SameFileState {
  return {
    issued: "none",
    step: STEP_WRITE,
    name: null,
    colour: null,
    speed: null,
    seen_hns: [],
    reshow: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * The heads-up answers of the row and SW6.
 * `repair` (F1, with OP5): the dropped op is the write — write the pair's file to the agent's
 * own fresh name, then acknowledge. `confirm` and a `repair` without a dropped operation:
 * acknowledge "not affected". `info`: nothing.
 */
function answerHeadsUp(state: SameFileState, headsUp: HeadsUp, ownName: string): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    state.name = ownName;
    state.step = STEP_WRITE;
    statement = "wrote its own fresh name";
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: SameFileState, turn: PatternTurn): void {
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
      // The write's path exists at head unshown. On the drawn `d<number>` name the partner
      // landed first — the row's answer is the same as F1's: write the agent's own fresh
      // name. On the own name: read the file shown (W1), then write again.
      if (state.name === freshName(turn.attempt_id)) {
        state.reshow = true;
      } else {
        state.name = freshName(turn.attempt_id);
        state.step = STEP_WRITE;
      }
    } else if (code === "not_found" && issued === "reshow") {
      // The shown file went away: the name is free again, the write proceeds.
      state.reshow = false;
      state.step = STEP_WRITE;
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
  if (issued === "reshow") {
    state.reshow = false;
    state.step = STEP_WRITE;
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

export const SAME_FILE: Pattern = {
  id: "same-file",
  intent: "add a creature",
  truth: [], // the name is drawn; `truthOf` names it (10.3: `file:creatures/d<number>.js`)
  truthOf(rand) {
    return [`file:${dNameOf(rand())}`];
  },

  next(turn: PatternTurn): PatternStep {
    const state: SameFileState = turn.state === null ? initialState() : { ...(turn.state as SameFileState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    const ownName = freshName(turn.attempt_id);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp, ownName);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit; a
    // dropped-write repair already re-armed STEP_WRITE — do not send it back to submit.
    if (state.done && (state.acks.length > 0 || state.reshow)) {
      state.done = false;
      if (state.step !== STEP_WRITE) state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.reshow) {
      state.issued = "reshow";
      return { kind: "tool", tool: "read", args: { path: state.name }, state };
    }
    if (state.done) return { kind: "wait", state };

    if (state.step === STEP_WRITE) {
      if (state.name === null) {
        state.name = dNameOf(turn.rand());
        // The T-plain draws come from the agent's stream (SW1), colour first — the pair's
        // identical stream makes identical files.
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
      args: { summary: SAME_FILE.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
