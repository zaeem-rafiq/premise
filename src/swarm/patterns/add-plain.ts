// The `add-plain` canned pattern (02-tidepool.md 10.3): add a creature made of template T-plain
// (10.2) and submit. Truth list `bounce`, `step`, `wander`; on a `repair` (E2) on one of them it
// reads the entity again and acknowledges "still valid". Every other heads-up takes the default
// answers of SW6; a held agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";

/** The truth list of `add-plain` (02 10.3; the row's `bounce`, `step`, `wander` expanded per the
 * section's note on `entity:<path>#<name>` form). */
const TRUTH = [
  "entity:world/bounds.js#bounce",
  "entity:world/movement.js#step",
  "entity:world/movement.js#wander",
] as const;

const TRUTH_KEYS = new Set<string>(TRUTH);

/** The colour names of `PALETTE` (02 3.1), in spec order. One draw chooses the creature's colour. */
const PALETTE = [
  "white",
  "black",
  "grey",
  "silver",
  "red",
  "orange",
  "yellow",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
  "sand",
] as const;

/** The speeds the scripted creatures of the seed use (02 10.1): the cycle `edit-creature` steps. */
const SPEEDS = [1, 1.5, 2, 2.5] as const;

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
type Issued = "none" | "script" | "reread" | "rewrite" | "submit";

type AddPlainState = {
  issued: Issued;
  step: number;
  entries: string[];
  name: string | null;
  colour: string | null;
  speed: number | null;
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  rereads: string[]; // entity keys "path#name" to read again (E2 repairs)
  rewrite: boolean; // a dropped write to apply again (SW6)
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): AddPlainState {
  return {
    issued: "none",
    step: STEP_LIST,
    entries: [],
    name: null,
    colour: null,
    speed: null,
    seen_hns: [],
    rereads: [],
    rewrite: false,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/** T-plain of `02` 10.2 with `{colour}` and `{speed}` filled in. */
function tPlain(colour: string, speed: number): string {
  return `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "${colour}";
const SPEED = ${speed};

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;
}

/** The first free `creatures/s<number>.js` name in the listing, number zero-padded to at least 4
 * digits (02 10.2). */
function freshName(entries: readonly string[]): string {
  const used = new Set<number>();
  for (const entry of entries) {
    const match = /^s(\d+)\.js$/.exec(entry);
    if (match !== null) used.add(Number(match[1]));
  }
  let n = 0;
  while (used.has(n)) n += 1;
  return `creatures/s${String(n).padStart(4, "0")}.js`;
}

function fileNamesOf(result: object | undefined): string[] {
  if (result === undefined || !("entries" in result)) return [];
  const { entries } = result as { entries: unknown };
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (entry): entry is { name: string; type: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        (entry as { type?: unknown }).type === "file",
    )
    .map((entry) => entry.name);
}

function submitStatus(result: object | undefined): string | null {
  const status = (result as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : null;
}

/** The `acknowledge` and `statement` fields the next `submit` carries (01-core 4.9, CK1). */
function submitFields(acks: ReadonlyArray<{ hn: number; statement: string }>): {
  acknowledge?: number[];
  statement?: string;
} {
  if (acks.length === 0) return {};
  const hns = [...new Set(acks.map((ack) => ack.hn))].sort((a, b) => a - b);
  const statements = [...new Set(acks.map((ack) => ack.statement))];
  return { acknowledge: hns, statement: statements.join("; ") };
}

/** The entity key `world/bounds.js#bounce` as `read` arguments. */
function readArgsOf(key: string): { path: string; entity: string } {
  const cut = key.lastIndexOf("#");
  return { path: key.slice(0, cut), entity: key.slice(cut + 1) };
}

/**
 * SW6 and the pattern's own row (02 10.3): what a new heads-up costs.
 * `repair` (E2) on a truth entity: read it again, acknowledge "still valid".
 * `repair` with a dropped operation: apply the write again, then acknowledge.
 * `confirm` or any other `repair`: acknowledge, no edit ("not affected"). `info`: nothing.
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
      state.rewrite = true;
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
  // "reread" and "rewrite" answers need no bookkeeping: the acknowledgement was queued at
  // schedule time.
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

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    if (state.done && (state.acks.length > 0 || state.rereads.length > 0 || state.rewrite)) {
      state.done = false;
      state.step = STEP_SUBMIT;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.rereads.length > 0) {
      const key = state.rereads.shift() as string;
      state.issued = "reread";
      return { kind: "tool", tool: "read", args: readArgsOf(key), state };
    }
    if (state.rewrite && state.name !== null) {
      state.rewrite = false;
      state.issued = "rewrite";
      return {
        kind: "tool",
        tool: "write",
        args: { path: state.name, content: tPlain(state.colour as string, state.speed as number) },
        state,
      };
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
