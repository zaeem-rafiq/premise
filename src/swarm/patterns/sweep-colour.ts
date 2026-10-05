// The `sweep-colour` canned pattern (02-tidepool.md 10.3): `list` `creatures/`, take the first
// four kinds in name order, `read` each file, `replace` its first colour constant with the next
// palette name, `submit`. Its truth list is the listing premise itself: `listing:creatures/`.
//
// A `repair` (L1) — a name was added to the listing while the sweep was in flight (or surfaced
// by the late L1 check when its second edit makes it a sweep): `read` each added file and apply
// the same `replace` — the first colour constant steps to the next palette name — then
// acknowledge. A dropped operation (OP1/OP6) is applied again on the current source: the same
// recorded `replace` is re-issued verbatim, like `cosmetic` does (SW6); a landing that already
// repainted the file then answers `no_match` and the attempt withdraws. A second `repair`
// heads-up, or `limit_reached`, ends the attempt with `stop` `withdrawn` (SW7, TA9a).
// `confirm`, `info` and a `repair` without a dropped operation take the defaults of SW6; a held
// agent waits before its first `submit` (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { fileNamesOf, submitFields, submitStatus } from "../scripted.ts";
import { PALETTE } from "../templates.ts";

/** A `const <NAME> = "<colour>";` declaration — the first colour constant of a creature file
 * (10.2: `const BODY = "…";`, `const ARMS = "…";`). */
const COLOUR_DECL = /\bconst\s+\w+\s*=\s*"([a-z]+)"\s*;/;

/** The `replace` that steps `source`'s first colour constant one palette name forward, or null
 * when the file holds no palette colour to repaint (nothing to do for it). */
function repaintOf(source: string | null): { old: string; new: string } | null {
  if (source === null) return null;
  const match = COLOUR_DECL.exec(source);
  if (match === null) return null;
  const at = PALETTE.indexOf(match[1] as (typeof PALETTE)[number]);
  if (at < 0) return null;
  const next = PALETTE[(at + 1) % PALETTE.length] as string;
  const decl = match[0];
  return { old: decl, new: decl.replace(`"${match[1]}"`, `"${next}"`) };
}

/** The `content` text of a whole-file `read` result (4.4 `ReadFileResult`), or null. */
function fileSourceOf(result: object | undefined): string | null {
  const content = (result as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : null;
}

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "read" | "repaint" | "submit";

type SweepColourState = {
  issued: Issued;
  listed: boolean;
  reads: string[]; // creature file paths still to `read` (the head is in flight)
  repaints: Array<{ path: string; old: string; new: string }>; // queued `replace`s
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  repairs: number; // distinct `repair` heads-ups answered — the second withdraws (SW7)
  swept: string[]; // file paths already repainted or queued (L1 names are repaired once)
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): SweepColourState {
  return {
    issued: "none",
    listed: false,
    reads: [],
    repaints: [],
    seen_hns: [],
    repairs: 0,
    swept: [],
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/**
 * The heads-up answers of the row and SW6.
 * `repair` (L1): each added name of a `listing` diff — `read` the added file, then repaint it;
 * acknowledge "repainted the added files". A dropped `replace` (OP1/OP6) is re-issued verbatim
 * on the current source. The second `repair` ends the attempt `withdrawn` (SW7).
 * `confirm`, `info` and other `repair` items: acknowledge "not affected" / nothing (SW6).
 */
function answerHeadsUp(state: SweepColourState, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "repair") {
    state.repairs += 1;
    if (state.repairs >= 2) {
      state.withdrawn = true; // SW7: a sweep's second repair ends the attempt.
      return;
    }
  }
  if (headsUp.result === "info") return;
  let statement = "not affected";
  if (headsUp.result === "repair") {
    for (const item of headsUp.items) {
      if (item.premise.kind === "listing" && item.diff.kind === "listing") {
        for (const name of item.diff.added) {
          const path = `creatures/${name}`;
          if (!state.reads.includes(path) && !state.swept.includes(path)) {
            state.reads.push(path);
            statement = "repainted the added files";
          }
        }
      }
    }
    for (const dropped of headsUp.dropped_ops) {
      // The dropped op is a `replace` on a creature file: the edit is applied again on the
      // current source — the file is re-read and its first colour constant re-derived, as
      // `rescale-energy` re-reads a dropped creature repair (SW6).
      if (typeof dropped.path === "string" && !state.reads.includes(dropped.path)) {
        state.reads.push(dropped.path);
        statement = "reapplied the edit";
      }
    }
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: SweepColourState, turn: PatternTurn): void {
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
      state.reads.shift(); // the file vanished or is opaque: nothing to repaint in it
    } else {
      // SW6/SW7: `limit_reached`, `no_match` or `ambiguous`, and any other failure the script
      // cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
    // The `list`: the first four kinds in name order are the sweep's files.
    state.reads = fileNamesOf(last.result)
      .sort()
      .slice(0, 4)
      .map((name) => `creatures/${name}`);
    state.listed = true;
    return;
  }
  if (issued === "read") {
    const path = state.reads.shift() as string;
    const repaint = repaintOf(fileSourceOf(last.result));
    if (repaint !== null) {
      state.swept.push(path);
      state.repaints.push({ path, ...repaint });
    }
    return;
  }
  if (issued === "repaint") {
    state.repaints.shift(); // the confirmed `replace` leaves the queue
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

export const SWEEP_COLOUR: Pattern = {
  id: "sweep-colour",
  intent: "repaint the first four creatures",
  truth: ["listing:creatures/"],

  next(turn: PatternTurn): PatternStep {
    const state: SweepColourState = turn.state === null ? initialState() : { ...(turn.state as SweepColourState) };
    state.released ||= turn.released;

    consumeLast(state, turn);
    for (const headsUp of turn.heads_ups) answerHeadsUp(state, headsUp);

    // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
    if (state.done && (state.acks.length > 0 || state.reads.length > 0 || state.repaints.length > 0)) {
      state.done = false;
    }

    if (state.withdrawn) {
      const reason: AgentStopReason = "withdrawn";
      return { kind: "stop", reason, state };
    }
    if (state.reads.length > 0) {
      const path = state.reads[0] as string;
      state.issued = "read";
      return { kind: "tool", tool: "read", args: { path }, state };
    }
    if (state.repaints.length > 0) {
      const repaint = state.repaints[0] as { path: string; old: string; new: string };
      state.issued = "repaint";
      return { kind: "tool", tool: "replace", args: repaint, state };
    }
    if (state.done) return { kind: "wait", state };

    if (!state.listed) {
      state.issued = "script";
      return { kind: "tool", tool: "list", args: { path: "creatures/" }, state };
    }

    // The sweep's calls are spent: `submit`. SW8/SWR3: a held agent waits first until released.
    if (turn.hold && !state.released) return { kind: "wait", state };
    state.issued = "submit";
    return {
      kind: "tool",
      tool: "submit",
      args: { summary: SWEEP_COLOUR.intent, ...submitFields(state.acks) },
      state,
    };
  },
};
