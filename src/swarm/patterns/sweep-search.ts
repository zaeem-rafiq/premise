// The `sweep-search` canned pattern (02-tidepool.md 10.3): `search` for `wander(creature, 0.05)`
// in `creatures/`; for the first three containers `read` the entity, `replace` the match with
// `wander(creature, 0.1)`; `submit`. Its truth list is the query premise itself:
// `query:text:creatures/:wander(creature, 0.05)`.
//
// A `repair` (QT1) — a container was gained while the sweep is in flight: the same edit in each
// added container, then acknowledge "widened the wander in the new file too". An `info` (X0, a
// container gained before its first edit): the same edit in the gained container too (the row).
// A dropped `replace` (OP1/OP6) is issued again verbatim — the edit is fixed text — so a landing
// that already applied it answers `no_match` and the attempt withdraws, as `cosmetic` does
// (SW6). A second `repair` heads-up, or `limit_reached`, ends the attempt with `stop`
// `withdrawn` (SW7, TA9a). `confirm` and any other `repair` take the defaults of SW6; a held
// agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { readArgsOf, submitFields, submitStatus } from "../scripted.ts";

const QUERY = "wander(creature, 0.05)";
const QUERY_KEY = `text:creatures/:${QUERY}`;
const EDIT = { old: "wander(creature, 0.05)", new: "wander(creature, 0.1)" } as const;

/** The entity keys a `search` result names in `containers` (`creatures/s0000.js#update`). */
function containersOf(result: object | undefined): string[] {
  const containers = (result as { containers?: unknown } | undefined)?.containers;
  return Array.isArray(containers) ? containers.filter((c): c is string => typeof c === "string") : [];
}

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "read" | "widen" | "submit";

type SweepSearchState = {
  issued: Issued;
  searched: boolean;
  reads: string[]; // container keys `path#entity` still to `read` (the head is in flight)
  widens: string[]; // file paths still to `replace` (the head is in flight)
  widened: string[]; // paths a `replace` was already queued for — a gained container is edited once
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  repairs: number; // distinct `repair` heads-ups answered — the second withdraws (SW7)
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): SweepSearchState {
  return {
    issued: "none",
    searched: false,
    reads: [],
    widens: [],
    widened: [],
    seen_hns: [],
    repairs: 0,
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/** Queue the fixed `wander` edit for `path`, once. */
function queueWiden(state: SweepSearchState, path: string): void {
  if (state.widened.includes(path) || state.widens.includes(path)) return;
  state.widens.push(path);
}

/**
 * The heads-up answers of the row and SW6.
 * `repair` (QT1) and `info` (X0) whose query diff names added containers: the same edit in each
 * added container — a `replace` on its file. A dropped `replace` (OP1/OP6) is issued again with
 * the same fixed text. `confirm` and any other `repair`: acknowledge "not affected". The second
 * `repair` ends the attempt `withdrawn` (SW7).
 */
function answerHeadsUp(state: SweepSearchState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "repair") {
    state.repairs += 1;
    if (state.repairs >= 2) {
      state.withdrawn = true; // SW7: a sweep's second repair ends the attempt.
      return;
    }
  }
  let statement = "not affected";
  let widenedNew = false;
  for (const item of headsUp.items) {
    if (item.premise.kind === "query" && item.premise.key === QUERY_KEY && item.diff.kind === "query") {
      for (const added of item.diff.added) {
        const path = added.key.split("#")[0] as string;
        const before = state.widens.length;
        queueWiden(state, path);
        widenedNew ||= state.widens.length > before;
      }
    }
  }
  for (const dropped of headsUp.dropped_ops) {
    // The dropped op is the fixed `replace` on a creature file: the same edit is applied again
    // on the current source — verbatim, as `cosmetic` does; a landing that already applied it
    // answers `no_match` and the attempt withdraws (SW6).
    if (typeof dropped.path === "string") {
      state.widens.push(dropped.path);
      widenedNew = true;
    }
  }
  if (headsUp.result === "info") return; // the X0 edit is queued above; `info` has nothing to ack
  if (widenedNew) statement = "widened the wander in the new file too";
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: SweepSearchState, turn: PatternTurn): void {
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
      // decided again below, never replayed. A queued read or `replace` keeps its slot.
    } else if (issued === "read" && (code === "not_found" || code === "not_a_module")) {
      state.reads.shift(); // the container vanished or is opaque: nothing to widen in it
    } else {
      // SW6/SW7: `limit_reached`, `no_match` or `ambiguous`, and any other failure the script
      // cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
    // The `search`: the first three containers are the sweep's entities.
    state.reads = containersOf(last.result).slice(0, 3);
    state.searched = true;
    return;
  }
  if (issued === "read") {
    const key = state.reads.shift() as string;
    const path = key.split("#")[0] as string;
    state.widened.push(path);
    state.widens.push(path);
    return;
  }
  if (issued === "widen") {
    state.widens.shift(); // the confirmed `replace` leaves the queue
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
      // answer the waiting heads-ups, then submit again
    } else if (status === "rejected") {
      state.withdrawn = true; // the script cannot fix a rejected change
    } else if (status === "stopped") {
      state.done = true;
    }
  }
}

export const SWEEP_SEARCH: Pattern = {
  id: "sweep-search",
  intent: "widen the wander",
  truth: [`query:${QUERY_KEY}`],

  next(turn: PatternTurn): PatternStep {
    const state: SweepSearchState = turn.state === null ? initialState() : { ...(turn.state as SweepSearchState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    if (state.done && (state.acks.length > 0 || state.reads.length > 0 || state.widens.length > 0)) {
      state.done = false;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.reads.length > 0) {
      const key = state.reads[0] as string;
      state.issued = "read";
      return { kind: "tool", tool: "read", args: readArgsOf(key), state };
    }
    if (state.widens.length > 0) {
      const path = state.widens[0] as string;
      state.issued = "widen";
      return { kind: "tool", tool: "replace", args: { path, ...EDIT }, state };
    }
    if (state.done) return { kind: "wait", state };

    if (!state.searched) {
      state.issued = "script";
      return { kind: "tool", tool: "search", args: { path: "creatures/", query: QUERY }, state };
    }

    // The sweep's calls are spent: `submit`. SW8/SWR3: a held agent waits first until released.
    if (turn.hold && !state.released) return { kind: "wait", state };
    state.issued = "submit";
    return {
      kind: "tool",
      tool: "submit",
      args: { summary: SWEEP_SEARCH.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
