// The mutable state of one attempt's loop: the rows of `transcript`, the inbox of heads-ups,
// and the counters of `meta` (01-core 3.3, 05-agent 4.1): guide_read, shown/acked hn, tool_steps,
// model_calls, nudges, spend, and the mirrored attempt state (TL11). Pure data.

import type { HeadsUp } from "../../../protocol/headsup.ts";
import { TIDE_FILLS, type PromptFills } from "../../../protocol/agent-prompt.ts";
import type { Row } from "./rows.ts";

export type InboxEntry = {
  heads_up: HeadsUp;
  shown_step: number | null; // the row number that carried it to the model (shown_step of 3.3)
  received_at: number;
};

/** The `meta` counters the loop owns (TL1, TL9, TL10, TL11, TD5). `step` is the last row number. */
export type LoopMeta = {
  step: number;
  tool_steps: number; // TL1: calls the Agent sent to Trunk; a TD4 refusal is not one
  model_calls: number;
  nudges: number; // consecutive replies with no tool call (TL7)
  tokens_in: number;
  tokens_out: number;
  spent_usd: number; // TL4 sum plus full reservations of tries that ended without usage (4.7)
  shown_hn: number; // TL9
  acked_hn: number; // TL10
  state: string; // TL11 mirror of attempt.state; "working" until a response says otherwise
  stopped: string | null; // a pending stop reason (TL16), once the loop decides to stop
};

export type LoopState = {
  rows: Row[]; // the `transcript` table, in `step` order
  inbox: InboxEntry[]; // heads-ups held, in `hn` order
  meta: LoopMeta;
  /** MR4: a gap in the inbox or a `heads_ups_more` asked for a `sync` before the next model call. */
  syncNeeded: boolean;
  /** The pool context the prompt and the `guide_first` rule fill from (06-repos IR9 to IR11):
   * the tide pool's for a seed pool, the imported repository's own guide path — possibly none —
   * for a pool made from one. */
  fills: PromptFills;
};

export function newLoopMeta(): LoopMeta {
  return {
    step: 0,
    tool_steps: 0,
    model_calls: 0,
    nudges: 0,
    tokens_in: 0,
    tokens_out: 0,
    spent_usd: 0,
    shown_hn: 0,
    acked_hn: 0,
    state: "opened",
    stopped: null,
  };
}

export function newLoopState(fills: PromptFills = TIDE_FILLS): LoopState {
  return { rows: [], inbox: [], meta: newLoopMeta(), syncNeeded: false, fills };
}

/** Append a row; its `step` is the next row number (rows are 1-indexed, with no gap). */
export function appendRow(state: LoopState, row: Omit<Row, "step">): Row {
  const full: Row = { step: state.rows.length + 1, ...row };
  state.rows.push(full);
  state.meta.step = full.step;
  return full;
}
