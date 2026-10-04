// The `cosmetic` canned pattern (02-tidepool.md 10.3): `read` the whole file `world/energy.js`,
// `replace` one comment line with a reworded one from the fixed list below, `submit`. A comment
// change alters the file's blob but no entity hash, so a `cosmetic` landing never gives another
// pattern a heads-up (E0, F2). Two `cosmetic` attempts can meet on the same line: the later one's
// `replace` no longer matches (OP1), the heads-up drops the operation, and the pattern's reapply
// answers `no_match` -> `stop` `withdrawn` (SW6, TA9a). Everything else takes the defaults of
// SW6; a held agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { submitFields, submitStatus } from "../scripted.ts";

/**
 * The fixed list of rewordings (the row names no list, so this is the pattern's own). Each `old`
 * is a comment line of the seed's `world/energy.js` and occurs there exactly once; none of them
 * sits in the region of `ENERGY_MAX`, so a rescale landing sees the attempt through E2m (the
 * observed row of 10.3), never E1.
 */
const REWORDINGS: ReadonlyArray<{ old: string; new: string }> = [
  {
    old: "// What one tick of ordinary living costs.",
    new: "// The cost of one tick of ordinary living.",
  },
  {
    old: "// A creature below this level is hungry.",
    new: "// A creature under this level is hungry.",
  },
  {
    old: "// An empty creature rests for this many ticks, then wakes up full.",
    new: "// An empty creature rests this many ticks, then wakes full.",
  },
  {
    old: "// True when the creature takes part in the energy rules.",
    new: "// True when the creature joins the energy rules.",
  },
  {
    old: "// Take energy away. `amount` is in the same unit as ENERGY_MAX.",
    new: "// Remove energy. `amount` is in the same unit as ENERGY_MAX.",
  },
  {
    old: "// Give energy. `amount` is in the same unit as ENERGY_MAX.",
    new: "// Add energy. `amount` is in the same unit as ENERGY_MAX.",
  },
  {
    old: "// True when the creature is below HUNGRY_BELOW.",
    new: "// True when the creature is under HUNGRY_BELOW.",
  },
  {
    old: "// True while an empty creature is resting. The world does not update a resting creature.",
    new: "// True while an empty creature rests. A resting creature is not updated.",
  },
  {
    old: "// Called by the world once per tick for every creature that uses energy.",
    new: "// The world calls this once per tick for every creature that uses energy.",
  },
];

/** Script positions: 0 `read`, 1 `replace`, 2 `submit`. */
const STEP_READ = 0;
const STEP_REPLACE = 1;
const STEP_SUBMIT = 2;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "reapply" | "submit";

type CosmeticState = {
  issued: Issued;
  step: number;
  own: { old: string; new: string } | null; // the drawn rewording, for the SW6 reapply
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  reapply: boolean; // a dropped operation to apply again (SW6)
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): CosmeticState {
  return {
    issued: "none",
    step: STEP_READ,
    own: null,
    seen_hns: [],
    reapply: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * The heads-up answers of SW6 (the row names no repair of its own): `confirm` and `repair`
 * without a dropped operation acknowledge "not affected" with no edit; a dropped operation is
 * applied again on the current source, then acknowledged. `info`: nothing.
 */
function answerHeadsUp(state: CosmeticState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    state.reapply = true;
    statement = "reapplied the edit";
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: CosmeticState, turn: PatternTurn): void {
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
  // A "reapply" answer needs no bookkeeping: the acknowledgement was queued at schedule time.
}

export const COSMETIC: Pattern = {
  id: "cosmetic",
  intent: "reword a comment",
  truth: [],

  next(turn: PatternTurn): PatternStep {
    const state: CosmeticState = turn.state === null ? initialState() : { ...(turn.state as CosmeticState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    if (state.done && (state.acks.length > 0 || state.reapply)) {
      state.done = false;
      state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.reapply && state.own !== null) {
      state.reapply = false;
      state.issued = "reapply";
      return {
        kind: "tool",
        tool: "replace",
        args: { path: "world/energy.js", old: state.own.old, new: state.own.new },
        state,
      };
    }
    if (state.done) return { kind: "wait", state };

    if (state.step === STEP_READ) {
      state.issued = "script";
      return { kind: "tool", tool: "read", args: { path: "world/energy.js" }, state };
    }
    if (state.step === STEP_REPLACE) {
      if (state.own === null) {
        // The one draw of the agent's stream (SW1): which line of the fixed list it rewords.
        state.own = REWORDINGS[Math.floor(turn.rand() * REWORDINGS.length)] as {
          old: string;
          new: string;
        };
      }
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
      args: { summary: COSMETIC.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
