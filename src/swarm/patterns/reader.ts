// The `reader` canned pattern (02-tidepool.md 10.3): `read` the whole file `world/energy.js`;
// then `add-plain`. Its truth list is `add-plain`'s (`bounce`, `step`, `wander`).
//
// The whole-file read pins a `file:world/energy.js` premise the change never edits: a landing
// on that file gives the pattern an `info` heads-up and nothing to acknowledge — X0 before its
// write, F4 answered `holds` by scripted triage after it, because no entity of that file is in
// its truth list (the row's note). Every heads-up the wide read does not answer is forwarded
// to `add-plain`'s turn, whose state machine answers them by SW6 (an `info` is nothing; a
// `repair` that drops the creature write re-lists and rewrites the next free name; a held
// agent waits before its first `submit` — SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { ADD_PLAIN } from "./add-plain.ts";

type ReaderState = {
  wide: "issue" | "sent" | "done"; // the leading `read` of `world/energy.js`
  inner: unknown; // `add-plain`'s state once the wide read has answered
  gone: boolean; // the attempt was closed under the wide read
  withdrawn: boolean;
};

function initialState(): ReaderState {
  return { wide: "issue", inner: null, gone: false, withdrawn: false };
}

export const READER: Pattern = {
  id: "reader",
  intent: "add a creature",
  truth: ADD_PLAIN.truth, // `bounce`, `step`, `wander` (the row's, same as `add-plain`)

  next(turn: PatternTurn): PatternStep {
    const state: ReaderState = turn.state === null ? initialState() : { ...(turn.state as ReaderState) };
    state.wide = state.wide === "issue" && turn.last === null ? "issue" : state.wide;

    if (state.gone) return { kind: "wait", state };
    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.wide === "issue") {
      state.wide = "sent";
      return { kind: "tool", tool: "read", args: { path: "world/energy.js" }, state };
    }
    if (state.wide === "sent") {
      const last = turn.last;
      if (last === null) return { kind: "wait", state }; // cannot happen: a sent call answers
      if (last.error !== undefined) {
        const code = last.error.code;
        if (code === "attempt_closed" || code === "attempt_unknown") {
          state.gone = true;
          return { kind: "wait", state };
        }
        // `read` is never refused `heads_up_first`; any other failure the script cannot fix
        // ends the attempt `withdrawn` (SW6).
        state.withdrawn = true;
        const reason: AgentStopReason = "withdrawn";
        return { kind: "stop", reason, state };
      }
      state.wide = "done";
      // The wide read's answer is not an `add-plain` step: hand the inner pattern a fresh
      // `last` so it opens with its own `list`, and forward the heads-ups that arrived.
      const step = ADD_PLAIN.next({ ...turn, last: null, state: null });
      state.inner = step.state;
      return { ...step, state };
    }

    const step = ADD_PLAIN.next({ ...turn, state: state.inner });
    state.inner = step.state;
    return { ...step, state };
  },
};
