// `nextAction` — the pure decider of 05-agent.md 4.5 — with the pure effects the driver performs:
// writing rows, attaching the heads-up run of MR4, counting budgets of 4.7. The first row of the
// table that applies decides. Everything is a function of `LoopState`; the runner performs I/O.

import type { HeadsUp } from "../../../protocol/headsup.ts";
import type { ModelToolMessage, ToolResponse } from "../../../protocol/tools.ts";
import {
  CONTEXT_HARD_CHARS,
  MAX_ATTEMPT_TOKENS,
  MAX_ATTEMPT_USD,
  MAX_MODEL_CALLS,
  MAX_NUDGES,
  MAX_STEPS,
  MAX_TOOL_CALLS_PER_TURN,
  MODEL_MAX_TOKENS,
} from "../../../protocol/constants.ts";
import { TEXTS, type AgentTexts } from "./texts.ts";
import { appendRow, newLoopState, type InboxEntry, type LoopState } from "./state.ts";
import {
  decodeAssistant,
  decodeToolRow,
  type AssistantContent,
  type Row,
  type ToolCall,
  type ToolRowBody,
} from "./rows.ts";
import { utf8 } from "../../sync/index.ts";
import { inboxNext, headsUpUserMessage, toHeadsUpForModel, receiveHeadsUp } from "./heads-up.ts";
import { toolMessageFor } from "./tool-message.ts";
import { assembleMessages, firstRows } from "./context.ts";
import { buildModelRequest, reservationBound, type ModelPrice } from "./model.ts";

export type ModelConfig = {
  options: object; // MODEL_OPTIONS[model] of MG2
  price: ModelPrice;
};

export type Action =
  | { type: "stop"; reason: string } // TL16
  | { type: "idle"; why: "landed_or_stopped" | "waiting" } // rows 4 and 6
  | { type: "show_heads_ups"; heads_ups: HeadsUp[] } // rows 6/8: append the SP5 user row
  | { type: "nudge"; text: string } // row 7: append a user row with texts.nudge / nudge_cut
  | { type: "answer_rest"; reason: NotRunReason } // TL8: fill remaining calls with not_run
  | { type: "tool"; call: ToolCall } // row 5: process the next call of the last reply
  | {
      type: "model"; // row 8: a model call; everything needed is carried here
      messages: object[];
      request: Record<string, unknown>;
      request_bytes: number;
      elided_steps: number[];
    };

export type NotRunReason = "earlier_failed" | "heads_up" | "after_submit" | "too_many" | "interrupted";

const WAITING_STATES = new Set(["submitted", "validated", "held", "accepted"]);
const WORKING_STATES = new Set(["opened", "working", "going_around", "needs_confirm"]);

/** The last `assistant` row, and the calls of its reply that have no `tool` row yet. */
function pendingCalls(state: LoopState): { row: Row; calls: ToolCall[]; answered: number } | null {
  let row: Row | null = null;
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const candidate = state.rows[i];
    if (candidate === undefined) continue;
    if (candidate.role === "assistant") {
      row = candidate;
      break;
    }
    if (candidate.role === "user") return null; // a newer user row is being answered
  }
  if (row === null) return null;
  const body = decodeAssistant(row);
  const answered = state.rows.length - row.step; // tool rows written after it
  const calls = body.tool_calls.slice(answered);
  return { row, calls, answered };
}

/** Why a reply's remaining calls must be answered `not_run` (TL8), or null to keep processing. */
function haltReason(state: LoopState, pending: { row: Row; answered: number }): NotRunReason | null {
  if (pending.answered === 0) return null;
  if (pending.answered >= MAX_TOOL_CALLS_PER_TURN) return "too_many";
  const lastRow = state.rows[state.rows.length - 1];
  if (lastRow === undefined || lastRow.role !== "tool") return null;
  if (lastRow.tool === "submit") return "after_submit";
  const last = decodeToolRow(lastRow);
  if (last.message.error !== undefined) return "earlier_failed";
  if (last.message.heads_ups !== undefined && last.message.heads_ups.length > 0) return "heads_up";
  return null;
}

/** Consecutive replies that ended without a tool call (TL7): count them at the tail. */
function consecutiveNoCall(state: LoopState): number {
  let n = 0;
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const row = state.rows[i];
    if (row === undefined || row.role === "user") continue; // nudges and heads-up messages
    if (row.role === "tool") continue; // answered calls of an earlier reply
    if (row.role !== "assistant") break; // the system row ends the tail
    if (decodeAssistant(row).tool_calls.length === 0) n++;
    else break;
  }
  return n;
}

/**
 * The unshown run (HU6a): the heads-ups the next row may carry, and whether a gap or
 * `heads_ups_more` asks for a `sync` first (MR4).
 */
export function unshownRun(state: LoopState): { show: HeadsUp[]; sync: boolean; wake: boolean } {
  const { show, sync } = inboxNext(state.meta.shown_hn, state.inbox);
  return { show, sync: sync || state.syncNeeded === true, wake: show.some((hu) => hu.wake) };
}

/**
 * 4.5: the first row that applies decides. `journal` is the driver's recovery input (row 3); the
 * early runner never leaves one, so `null` there. `pendingStop` is the reason TL16 recorded.
 */
export function nextAction(
  state: LoopState,
  cfg: { model: ModelConfig; journal?: unknown; texts?: AgentTexts },
): Action {
  // 1. A stop is pending.
  if (state.meta.stopped !== null) return { type: "stop", reason: state.meta.stopped };

  // 2. A resume was accepted and no row was written since — the early runner never resumes, and
  //    the engine marks this in its journal; not decidable from the transcript alone.
  // 3. A journal row of a call in progress exists.
  if (cfg.journal !== undefined && cfg.journal !== null) {
    return { type: "idle", why: "waiting" }; // recovery is the driver's AG2 path, not a model action
  }

  // 4. The mirrored state is terminal.
  if (state.meta.state === "landed" || state.meta.state === "stopped") {
    return { type: "idle", why: "landed_or_stopped" };
  }

  const pending = pendingCalls(state);

  // 5. The last assistant row has tool calls without a tool row.
  if (pending !== null && pending.calls.length > 0) {
    const reason = haltReason(state, pending);
    if (reason !== null) return { type: "answer_rest", reason };
    const next = pending.calls[0];
    if (next === undefined) return { type: "answer_rest", reason: "interrupted" };
    return { type: "tool", call: next };
  }

  const run = unshownRun(state);

  // 6. Waiting states: a waking unshown run is shown, otherwise wait.
  if (WAITING_STATES.has(state.meta.state)) {
    if (run.wake) return { type: "show_heads_ups", heads_ups: run.show };
    return { type: "idle", why: "waiting" };
  }

  if (WORKING_STATES.has(state.meta.state)) {
    // 7. The last row is an assistant row with no tool call.
    const last = state.rows[state.rows.length - 1];
    if (last !== undefined && last.role === "assistant" && decodeAssistant(last).tool_calls.length === 0) {
      if (consecutiveNoCall(state) >= MAX_NUDGES) {
        return { type: "stop", reason: "model_error:no_tool_call" };
      }
      const lastBody = decodeAssistant(last);
      const texts = cfg.texts ?? TEXTS;
      return { type: "nudge", text: lastBody.finish_reason === "length" ? texts.nudge_cut : texts.nudge };
    }
    // 8. Any other last row: a waking unshown run is shown first (TL5), then a model call.
    if (run.wake) return { type: "show_heads_ups", heads_ups: run.show };

    // Budgets of 4.7, checked before the model call they would exceed.
    if (state.meta.model_calls >= MAX_MODEL_CALLS) return { type: "stop", reason: "budget" };
    if (state.meta.tokens_in + state.meta.tokens_out >= MAX_ATTEMPT_TOKENS) {
      return { type: "stop", reason: "budget" };
    }
    const assembled = assembleMessages(state, cfg.texts ?? TEXTS);
    if (!assembled.ok) return { type: "stop", reason: "budget:context_overflow" };
    const request = buildModelRequest({ messages: assembled.messages, options: cfg.model.options });
    const requestBytes = utf8(JSON.stringify(request)).byteLength;
    const bound = reservationBound(requestBytes, MODEL_MAX_TOKENS, cfg.model.price);
    if (state.meta.spent_usd + bound > MAX_ATTEMPT_USD) return { type: "stop", reason: "budget" };
    return {
      type: "model",
      messages: assembled.messages,
      request,
      request_bytes: requestBytes,
      elided_steps: assembled.elided_steps,
    };
  }

  return { type: "idle", why: "waiting" };
}

/** Before a tool call is sent (4.7): the step budget decides first. */
export function toolBudgetOk(state: LoopState): boolean {
  return state.meta.tool_steps < MAX_STEPS;
}

// ---- Pure effects: writing rows ----

/** The first two rows of a fresh attempt (SP1, SP2). */
export function startAttempt(state: LoopState, intentText: string, startedAt: number): void {
  for (const row of firstRows(intentText)) {
    appendRow(state, {
      role: row.role,
      content: row.content,
      tool: null,
      call_id: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: startedAt,
      ended_at: null,
    });
  }
}

/**
 * Write the tool row for one call (TL14): `message` is the MR1 object the model reads;
 * `trunk_error` Trunk's own error text, kept beside it. Writing the row raises `shown_hn` for the
 * heads-ups it carries (TL9) and stamps their `shown_step`.
 */
export function writeToolRow(
  state: LoopState,
  parts: {
    tool: string;
    call_id: string | null;
    model_call_id: string;
    args: object;
    message: ModelToolMessage;
    trunk_error?: string | null;
    counts_step: boolean; // a real tool step (sent to Trunk) or a TD4 row
    started_at: number;
    ended_at: number;
  },
): Row {
  const body: ToolRowBody = {
    message: parts.message,
    trunk_error: parts.trunk_error ?? null,
    args: parts.args,
    model_call_id: parts.model_call_id,
  };
  const row = appendRow(state, {
    role: "tool",
    content: JSON.stringify(body),
    tool: parts.tool,
    call_id: parts.call_id,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: parts.started_at,
    ended_at: parts.ended_at,
  });
  if (parts.counts_step) state.meta.tool_steps++;
  const shown = parts.message.heads_ups ?? [];
  for (const hu of shown) {
    const entry = state.inbox.find((e) => e.heads_up.hn === hu.hn);
    if (entry !== undefined) entry.shown_step = row.step;
    if (hu.hn > state.meta.shown_hn) state.meta.shown_hn = hu.hn;
  }
  return row;
}

/**
 * Build the `ModelToolMessage` for a `ToolResponse` (MR1 to MR4): response heads-ups enter the
 * inbox first, then the unshown run rides in this message. `needsSync` reports MR4's sync rule.
 */
export function messageForResponse(
  state: LoopState,
  response: ToolResponse,
  texts: AgentTexts = TEXTS,
): { message: ModelToolMessage; needsSync: boolean } {
  for (const hu of response.heads_ups) receiveHeadsUp(state, hu, 0);
  const run = unshownRun(state);
  const heads_ups = run.show.map((hu) => toHeadsUpForModel(hu, texts));
  const message = response.ok
    ? toolMessageFor({ result: response.result ?? {}, heads_ups, texts })
    : toolMessageFor({
        error: { code: response.error?.code ?? "other", detail: response.error?.detail },
        heads_ups,
        texts,
      });
  return { message, needsSync: run.sync || response.heads_ups_more };
}

/** Write the assistant row of a parsed answer (TL14); `model` is the model id. */
export function writeAssistantRow(
  state: LoopState,
  parts: {
    answer: AssistantContent;
    model: string;
    tokens_in: number | null;
    tokens_out: number | null;
    started_at: number;
    ended_at: number;
  },
): Row {
  state.meta.model_calls++;
  state.meta.tokens_in += parts.tokens_in ?? 0;
  state.meta.tokens_out += parts.tokens_out ?? 0;
  return appendRow(state, {
    role: "assistant",
    content: JSON.stringify(parts.answer),
    tool: null,
    call_id: null,
    model: parts.model,
    tokens_in: parts.tokens_in,
    tokens_out: parts.tokens_out,
    started_at: parts.started_at,
    ended_at: parts.ended_at,
  });
}

/** Append a `user` row (SP5 heads-up message, nudge, resume text). Marks heads-ups shown (TL9). */
export function writeUserRow(state: LoopState, content: string, at: number): Row {
  const row = appendRow(state, {
    role: "user",
    content,
    tool: null,
    call_id: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: at,
    ended_at: null,
  });
  // TL9: a heads-up message raises shown_hn for the heads-ups it holds.
  try {
    const parsed = JSON.parse(content) as { heads_ups?: Array<{ hn?: number }> };
    for (const hu of parsed.heads_ups ?? []) {
      if (typeof hu.hn === "number") {
        const entry = state.inbox.find((e) => e.heads_up.hn === hu.hn);
        if (entry !== undefined) entry.shown_step = row.step;
        if (hu.hn > state.meta.shown_hn) state.meta.shown_hn = hu.hn;
      }
    }
  } catch {
    // a plain-text user row (nudge, resume) carries no heads-ups
  }
  return row;
}

/** The SP5 text for the heads-ups `nextAction` decided to show. */
export function headsUpMessage(headsUps: readonly HeadsUp[], texts: AgentTexts = TEXTS): string {
  return headsUpUserMessage(headsUps, texts);
}

/** Mirror `attempt.state` (TL11) and count a spend (4.7 money line). */
export function applyResponseMeta(state: LoopState, response: ToolResponse, costUsd?: number): void {
  state.meta.state = response.attempt.state;
  if (costUsd !== undefined) state.meta.spent_usd += costUsd;
}

/** A fresh loop state for a new run (each measurement run starts empty, ME4). */
export function freshState(): LoopState {
  return newLoopState();
}
