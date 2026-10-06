// The `add-plain` canned pattern (02-tidepool.md 10.3): add a creature made of template T-plain
// (10.2) and submit. Its file goes to the agent's own fresh name — `creatures/s-<id>.js`, `<id>`
// the first 10 characters of its attempt id after `a_` — so two concurrent agents never race a
// `creatures/` listing for the next free number. Truth list `bounce`, `step`, `wander`; on a
// `repair` (E2) on one of them it reads the entity again and acknowledges "still valid". Every
// other heads-up takes the default answers of SW6; a held agent waits before its first `submit`
// (SW8, SWR3).
//
// A `write` or `submit` sent while an unshown heads-up waits is refused `heads_up_first` (TA3):
// the operation is NOT recorded, and the heads-up arrives on that answer. Queued re-reads keep
// their slot until confirmed, so a refused one is re-issued rather than skipped.
//
// Points where the row is silent, answered from SW6's reapply-on-the-current-source:
// a dropped write (F1/OP5, or any other cause) is written to the agent's own name again and
// acknowledged; `read_first` on the write — the name exists at head unshown — `read`s the file
// first (W1) and writes it again.

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { freshName, readArgsOf, submitFields, submitStatus } from "../scripted.ts";
import { PALETTE, SPEEDS, tPlain } from "../templates.ts";

/** The truth list of `add-plain` (02 10.3; the row's `bounce`, `step`, `wander` expanded per the
 * section's note on `entity:<path>#<name>` form). */
const TRUTH = [
  "entity:world/bounds.js#bounce",
  "entity:world/movement.js#step",
  "entity:world/movement.js#wander",
] as const;

const TRUTH_KEYS = new Set<string>(TRUTH);

/** The entity a scripted `read` names (`world/bounds.js#bounce` -> `{ path, entity }`). */
const READ_ENTITIES: ReadonlyArray<{ path: string; entity: string }> = [
  { path: "world/bounds.js", entity: "bounce" },
  { path: "world/movement.js", entity: "step" },
  { path: "world/movement.js", entity: "wander" },
];

/** Script positions: 0 `list`, 1 `read GUIDE.md`, 2 to 4 the entity reads, 5 `write`, 6 `submit`. */
const STEP_LIST = 0;
const STEP_WRITE = 5;
const STEP_SUBMIT = 6;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "reshow" | "reread" | "submit";

type AddPlainState = {
  issued: Issued;
  step: number;
  name: string | null;
  colour: string | null;
  speed: number | null;
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  rereads: string[]; // entity keys "path#name" to read again (E2 repairs); the head is in flight
  reshow: boolean; // the write answered `read_first`: read the file shown (W1), then write again
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): AddPlainState {
  return {
    issued: "none",
    step: STEP_LIST,
    name: null,
    colour: null,
    speed: null,
    seen_hns: [],
    rereads: [],
    reshow: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * SW6 and the pattern's own row (02 10.3): what a new heads-up costs.
 * `repair` (E2) on a truth entity: read it again, acknowledge "still valid".
 * `repair` with a dropped operation: the write is gone — write the agent's own name on the
 * current source again, then acknowledge. `confirm` or any other `repair`: acknowledge, no
 * edit ("not affected"). `info`: nothing.
 */
function answerHeadsUp(state: AddPlainState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair") {
    let onTruth = false;
    for (const item of headsUp.items) {
      if (
        item.rule === "E2" &&
        item.result === "repair" &&
        item.premise.kind === "entity" &&
        TRUTH_KEYS.has(`entity:${item.premise.key}`)
      ) {
        state.rereads.push(item.premise.key);
        onTruth = true;
      }
    }
    if (onTruth) statement = "still valid";
    if (headsUp.dropped_ops.length > 0) {
      // The dropped op is the creature write (the only write the pattern makes): the name is
      // still the agent's own — the write is applied again on the current source.
      state.step = STEP_WRITE;
      statement = "reapplied the edit";
    }
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: AddPlainState, turn: PatternTurn): void {
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
      // The write's path exists at head unshown: read it first (W1), then write again.
      state.reshow = true;
    } else if (code === "not_found" && issued === "reshow") {
      // The shown file went away: the name is free again, the write proceeds.
      state.reshow = false;
      state.step = STEP_WRITE;
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
  if (issued === "reshow") {
    state.reshow = false;
    state.step = STEP_WRITE;
    return;
  }
  if (issued === "reread") {
    state.rereads.shift(); // the confirmed re-read leaves the queue
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

export const ADD_PLAIN: Pattern = {
  id: "add-plain",
  intent: "add a creature",
  truth: TRUTH,

  next(turn: PatternTurn): PatternStep {
    const state: AddPlainState = turn.state === null ? initialState() : { ...(turn.state as AddPlainState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit; a
    // dropped-write repair already re-armed STEP_WRITE — do not send it back to submit.
    if (state.done && (state.acks.length > 0 || state.rereads.length > 0 || state.reshow)) {
      state.done = false;
      if (state.step !== STEP_WRITE) state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.rereads.length > 0) {
      const key = state.rereads[0] as string;
      state.issued = "reread";
      return { kind: "tool", tool: "read", args: readArgsOf(key), state };
    }
    if (state.reshow) {
      state.issued = "reshow";
      return { kind: "tool", tool: "read", args: { path: state.name }, state };
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
        state.name = freshName(turn.attempt_id);
        // Both draws come from the agent's stream (SW1), colour first.
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
      args: { summary: ADD_PLAIN.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
