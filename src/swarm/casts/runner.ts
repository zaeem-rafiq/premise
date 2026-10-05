// The shared skeleton of the canned casts of 02-tidepool.md 10.5 (SW4 to SW8). Each cast is a
// linear script of canned tool calls plus the answers its section gives a heads-up; this runner
// holds the rules every one of them keeps:
//
//   - a `write`, `replace` or `submit` refused `heads_up_first` (TA3) was NOT recorded: the call
//     stays at the head of its queue and is decided again — never replayed, so a `args` given as
//     a function is re-evaluated against the freshest state;
//   - a queued repair keeps its slot until confirmed; a queued `read` that answers `not_found`
//     or `not_a_module` is dropped (its target vanished or is opaque);
//   - a call answering `no_match`, `ambiguous`, `limit_reached` or any other failure the script
//     cannot fix ends the attempt `withdrawn` (SW6);
//   - a heads-up can arrive at any point; `confirm`/`repair` are acknowledged by the next submit
//     (CK1); an `info` needs no acknowledgement;
//   - a heads-up that reopens a decided attempt (T8, GA3) sends it back to its submit;
//   - `hold` parks the pattern before every `submit` until `released` (SW8/SWR3);
//   - `secondRepairWithdraws` is SW7: a scripted sweep gives up at its second repair.
//
// `dropped_ops` a cast does not claim in `onHeadsUp` end it `withdrawn`: a canned file cannot
// re-derive its write under a moved base, and a canned `replace` that no longer applies is the
// SW6 "cannot be applied" case.

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ToolName } from "../../protocol/tools.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { submitFields, submitStatus } from "../scripted.ts";

/**
 * One canned call. `args` may be a function: it is evaluated at issue time, so a refused call is
 * re-decided with the freshest state (a write's text follows what a heads-up changed). `why` is a
 * label `onResult` correlates results with; it never reaches the engine.
 */
export type CastCall = {
  tool: ToolName;
  args: Record<string, unknown> | ((s: CastState) => Record<string, unknown>);
  why?: string;
};

/** The pattern state a cast carries between turns (the driver stores it verbatim). */
export type CastState = {
  issued: "none" | "queue" | "script" | "submit";
  i: number; // the next script item to expand
  pending: CastCall[]; // the expanded calls of the script so far, FIFO
  queue: CastCall[]; // repairs and follow-up reads, ahead of the script
  seen: number[]; // heads-up numbers already answered (re-pushes arrive again, HU5)
  acks: Array<{ hn: number; statement: string }>;
  repairs: number; // repair heads-ups answered (SW7)
  released: boolean;
  withdrawn: boolean;
  done: boolean;
  current: CastCall | null; // the call in flight, for `onResult`
  data: Record<string, unknown>; // the cast's own scratch space
};

function initialState(): CastState {
  return {
    issued: "none",
    i: 0,
    pending: [],
    queue: [],
    seen: [],
    acks: [],
    repairs: 0,
    released: false,
    withdrawn: false,
    done: false,
    current: null,
    data: {},
  };
}

/** What one canned cast is made of. */
export type CastSpec = {
  id: string;
  intent: string;
  truth: readonly string[];
  /** The submit's `summary`; the intent text when omitted. */
  summary?: string;
  /**
   * The canned calls in order, before the submit the runner issues itself. A function item is
   * expanded when reached — its calls may use data earlier results left in `s.data` — and may
   * answer `null` or `[]` to be skipped.
   */
  script: ReadonlyArray<CastCall | ((s: CastState) => CastCall | CastCall[] | null)>;
  /** A call answered `ok`. `s.queue` may gain follow-up calls (reads, repairs). */
  onResult?(s: CastState, call: CastCall, result: object): void;
  /**
   * A heads-up arrived (once each, ascending hn). Queue repairs through `s.queue`; set
   * `ack.statement` for the next submit's `statement` (the default is "not affected"). Set
   * `ack.dropped` to `"handled"` when the cast re-derived what `hu.dropped_ops` held — the
   * default is the SW6 "cannot be applied" case: `stop` `withdrawn`.
   */
  onHeadsUp?(s: CastState, hu: HeadsUp, ack: { statement: string; dropped?: "handled" }): void;
  /** SW7: a scripted sweep stops `withdrawn` at its second `repair` heads-up. */
  secondRepairWithdraws?: boolean;
};

/** What the answer to the last issued call changes. */
function consumeLast(spec: CastSpec, s: CastState, turn: PatternTurn): void {
  const last = turn.last;
  if (last === null || s.issued === "none") return;
  const issued = s.issued;
  const call = s.current;
  s.issued = "none";
  if (last.error !== undefined) {
    const code = last.error.code;
    if (code === "attempt_closed" || code === "attempt_unknown") {
      s.done = true;
    } else if (code === "heads_up_first") {
      // TA3: refused without being recorded; the heads-ups ride this answer and the step is
      // decided again below — the call keeps its head-of-queue slot.
    } else if (issued === "queue" && call?.tool === "read" && (code === "not_found" || code === "not_a_module")) {
      s.queue.shift(); // its target vanished or is opaque: nothing to repair
    } else {
      s.withdrawn = true; // SW6: a failure the script cannot fix
    }
    return;
  }
  if (issued === "queue") {
    s.queue.shift();
    if (call !== null) spec.onResult?.(s, call, last.result ?? {});
    return;
  }
  if (issued === "script") {
    s.pending.shift();
    if (call !== null) spec.onResult?.(s, call, last.result ?? {});
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
      s.acks = [];
      s.done = true;
    } else if (status === "needs_confirm" || status === "go_around") {
      // Answer the waiting heads-ups, then submit again (the queue drains first).
    } else if (status === "rejected") {
      s.withdrawn = true; // the script cannot fix a rejected change
    } else if (status === "stopped") {
      s.done = true;
    }
  }
}

function answerHeadsUp(spec: CastSpec, s: CastState, hu: HeadsUp): void {
  if (s.seen.includes(hu.hn)) return;
  s.seen.push(hu.hn);
  if (hu.result === "repair") {
    s.repairs += 1;
    if (spec.secondRepairWithdraws === true && s.repairs >= 2) {
      s.withdrawn = true; // SW7
      return;
    }
  }
  const ack: { statement: string; dropped?: "handled" } = { statement: "not affected" };
  spec.onHeadsUp?.(s, hu, ack);
  if (hu.result !== "info") s.acks.push({ hn: hu.hn, statement: ack.statement });
  // Dropped operations the cast did not claim (it may have re-queued them in `onHeadsUp`)
  // are the SW6 "cannot be applied" case: the canned edit cannot be re-derived.
  if (s.withdrawn) return;
  if (hu.dropped_ops.length > 0 && ack.dropped !== "handled") s.withdrawn = true;
  // A `confirm` or `repair` after a successful submit reopens work (T8, GA3): the queue
  // drains and the submit runs again with the acknowledgement.
  if (s.done && hu.result !== "info") s.done = false;
}

/** The pure `Pattern` one canned cast becomes. */
export function cannedCast(spec: CastSpec): Pattern {
  return {
    id: spec.id,
    intent: spec.intent,
    truth: spec.truth,

    next(turn: PatternTurn): PatternStep {
      const s: CastState = turn.state === null ? initialState() : { ...(turn.state as CastState) };
      s.released ||= turn.released;

      consumeLast(spec, s, turn);
      for (const hu of turn.heads_ups) answerHeadsUp(spec, s, hu);

      if (s.withdrawn) {
        const reason: AgentStopReason = "withdrawn";
        return { kind: "stop", reason, state: s };
      }
      if (s.queue.length > 0) {
        const call = s.queue[0] as CastCall;
        s.issued = "queue";
        s.current = call;
        const args = typeof call.args === "function" ? call.args(s) : call.args;
        return { kind: "tool", tool: call.tool, args, state: s };
      }
      if (s.done) return { kind: "wait", state: s };

      // Expand script items until one yields a call.
      while (s.pending.length === 0 && s.i < spec.script.length) {
        const item = spec.script[s.i] as CastCall | ((s: CastState) => CastCall | CastCall[] | null);
        s.i += 1;
        const produced = typeof item === "function" ? item(s) : item;
        if (produced === null) continue;
        if (Array.isArray(produced)) s.pending.push(...produced);
        else s.pending.push(produced);
      }
      if (s.pending.length > 0) {
        const call = s.pending[0] as CastCall;
        s.issued = "script";
        s.current = call;
        const args = typeof call.args === "function" ? call.args(s) : call.args;
        return { kind: "tool", tool: call.tool, args, state: s };
      }

      // The script is spent: `submit`. SW8/SWR3: a held agent waits before every submit.
      if (turn.hold && !s.released) return { kind: "wait", state: s };
      s.issued = "submit";
      s.current = null;
      return {
        kind: "tool",
        tool: "submit",
        args: { summary: spec.summary ?? spec.intent, ...submitFields(s.acks) },
        state: s,
      };
    },
  };
}
