// The `same-file` canned pattern (02-tidepool.md 10.3): agents come in pairs — the launcher
// gives both members of a pair the same draw stream, so both `write` T-plain to the same fresh
// name `creatures/d<number>.js` (the number is the agent's first `rand` draw) — then `submit`.
// `truthOf` on a fresh stream names the drawn file: `file:creatures/d<number>.js` (the row).
//
// A `repair` (F1, with OP5) — the partner's landing took the name out from under the recorded
// `write`: `list` the directory, `write` the next free `d<number>` name, acknowledge (the row).
// `read_first` on the write — the name was landed between the draw and the call — answers the
// same way. `info` does nothing; `confirm` (B1's blind-spot turn, or any other) and a `repair`
// without a dropped operation acknowledge "not affected" (SW6). Any call answering
// `limit_reached`, `no_match` or `ambiguous` ends the attempt `withdrawn` (SW6, TA9a); a held
// agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { fileNamesOf, submitFields, submitStatus } from "../scripted.ts";
import { PALETTE, SPEEDS, tPlain } from "../templates.ts";

/** The `creatures/d<number>.js` name of draw `u` — zero-padded to at least 4 digits. */
function dNameOf(u: number): string {
  return `creatures/d${String(Math.floor(u * 10000)).padStart(4, "0")}.js`;
}

/** The next free `creatures/d<number>.js` name in `entries` (the row's repair name). */
function nextFreeD(entries: readonly string[]): string {
  const used = new Set<number>();
  for (const entry of entries) {
    const match = /^d(\d+)\.js$/.exec(entry);
    if (match !== null) used.add(Number(match[1]));
  }
  let n = 0;
  while (used.has(n)) n += 1;
  return `creatures/d${String(n).padStart(4, "0")}.js`;
}

/** Script positions: 0 `write`, 1 `submit`. A repair's re-list rides `relist`. */
const STEP_WRITE = 0;
const STEP_SUBMIT = 1;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "relist" | "submit";

type SameFileState = {
  issued: Issued;
  step: number;
  name: string | null; // the drawn `d<number>` name, or the relist's next free one
  colour: string | null;
  speed: number | null;
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  relist: boolean; // the name raced a landing: list again, then write the next free name
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
    relist: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * The heads-up answers of the row and SW6.
 * `repair` (F1, with OP5): the dropped op is the write — `list` again and write the next free
 * name, then acknowledge "wrote the next free name". `confirm` and a `repair` without a dropped
 * operation: acknowledge "not affected". `info`: nothing.
 */
function answerHeadsUp(state: SameFileState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    state.name = null;
    state.relist = true;
    state.step = STEP_WRITE;
    statement = "wrote the next free name";
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
    } else if (code === "read_first" && (issued === "script" || issued === "relist")) {
      // The name was taken between the draw (or the list) and the write: list again, then
      // write the next free `d<number>` name — the row's repair answer.
      state.relist = true;
      state.name = null;
    } else {
      // SW6: `limit_reached`, `no_match` or `ambiguous`, and any other failure the script
      // cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "relist") {
    state.name = nextFreeD(fileNamesOf(last.result));
    state.relist = false;
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
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    // A repair already re-armed `STEP_WRITE` for the relist's rewrite — the reopen only forces
    // `STEP_SUBMIT` when no rewrite is pending, or the write would be submitted as nothing.
    if (state.done && (state.acks.length > 0 || state.relist)) {
      state.done = false;
      if (!state.relist) state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.relist) {
      state.issued = "relist";
      return { kind: "tool", tool: "list", args: { path: "creatures/" }, state };
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
