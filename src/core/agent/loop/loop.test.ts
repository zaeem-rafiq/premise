// `nextAction` — the decision table of 05-agent.md 4.5 — with the pure effects: row writing (TL14),
// heads-up delivery (MR4, TL9), nudges (TL7), not_run answers (TL8) and budgets (4.7).

import { describe, it, expect } from "vitest";
import {
  nextAction,
  writeAssistantRow,
  writeToolRow,
  writeUserRow,
  headsUpMessage,
  messageForResponse,
  startAttempt,
  toolBudgetOk,
  unshownRun,
} from "./loop.ts";
import { newLoopState, appendRow, type LoopState } from "./state.ts";
import { decodeAssistant, type ToolCall } from "./rows.ts";
import { toolMessageFor } from "./tool-message.ts";
import type { ToolResponse } from "../../../protocol/tools.ts";
import type { HeadsUp } from "../../../protocol/headsup.ts";
import {
  MAX_MODEL_CALLS,
  MAX_STEPS,
  MAX_ATTEMPT_TOKENS,
  MAX_NUDGES,
  MAX_TOOL_CALLS_PER_TURN,
} from "../../../protocol/constants.ts";
import { GUIDE_PATH, firstUserMessage } from "../../../protocol/agent-prompt.ts";

const CFG = { model: { options: {}, price: { input: 1, output: 1 } } };

function hu(hn: number, over: Partial<HeadsUp> = {}): HeadsUp {
  return {
    hn,
    attempt_id: "a_t",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [1], changes: [] },
    items: [],
    dropped_ops: [],
    go_around: 1,
    head_seq: 1,
    created_at: 0,
    ...over,
  };
}

function assistant(state: LoopState, calls: Array<[string, object]>, finish = "stop"): ToolCall[] {
  const toolCalls: ToolCall[] = calls.map(([name, args], i) => ({
    id: `call_${i}`,
    type: "function",
    function: { name, arguments: args },
  }));
  writeAssistantRow(state, {
    answer: { content: "", tool_calls: toolCalls, finish_reason: finish },
    model: "m",
    tokens_in: 1,
    tokens_out: 1,
    started_at: 0,
    ended_at: 1,
  });
  return toolCalls;
}

function toolOk(state: LoopState, tool: string, args: object, result: object, heads_ups: HeadsUp[] = []): void {
  writeToolRow(state, {
    tool,
    call_id: `a_t:${state.rows.length + 1}`,
    model_call_id: "call_0",
    args,
    message: toolMessageFor({
      result,
      heads_ups: heads_ups.map((h) => ({
        hn: h.hn,
        action: "repair",
        because: "",
        changed_by: null,
        items: [],
        dropped_edits: [],
      })),
    }),
    counts_step: true,
    started_at: 0,
    ended_at: 0,
  });
}

function response(over: Partial<ToolResponse> = {}): ToolResponse {
  return {
    call_id: "a_t:1",
    ok: true,
    head_seq: 0,
    result: {},
    premises: [],
    heads_ups: [],
    heads_ups_more: false,
    attempt: { state: "working", go_arounds: 0, pull_backs: 0 },
    ...over,
  };
}

describe("4.5 rows 4/6/8: the first row that applies", () => {
  it("a fresh attempt makes a model call with SP1/SP2 as the first messages", () => {
    const state = newLoopState();
    startAttempt(state, "a jellyfish that drifts", 0);
    const action = nextAction(state, CFG);
    expect(action.type).toBe("model");
    if (action.type !== "model") return;
    expect(action.messages[0]).toEqual({ role: "system", content: expect.any(String) });
    expect(action.messages[1]).toEqual({ role: "user", content: firstUserMessage("a jellyfish that drifts") });
    expect((action.request as { messages: unknown }).messages).toBe(action.messages);
  });

  it("row 5: pending tool calls are processed in order, one per action", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    assistant(state, [
      ["read", { path: GUIDE_PATH }],
      ["read", { path: "a.js" }],
    ]);
    const a1 = nextAction(state, CFG);
    expect(a1.type).toBe("tool");
    if (a1.type === "tool") expect(a1.call.function.name).toBe("read");
    toolOk(state, "read", { path: GUIDE_PATH }, { content: "guide" });
    const a2 = nextAction(state, CFG);
    expect(a2.type).toBe("tool");
    if (a2.type === "tool") expect((a2.call.function.arguments as { path: string }).path).toBe("a.js");
    toolOk(state, "read", { path: "a.js" }, { content: "x" });
    expect(nextAction(state, CFG).type).toBe("model");
  });

  it("TL6: after a tool row leaves the mirrored state at validated, no model call follows", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.meta.state = "validated";
    expect(nextAction(state, CFG)).toEqual({ type: "idle", why: "waiting" });
  });

  it("row 4: mirrored state landed or stopped ends the loop", () => {
    for (const s of ["landed", "stopped"]) {
      const state = newLoopState();
      startAttempt(state, "i", 0);
      state.meta.state = s;
      expect(nextAction(state, CFG)).toEqual({ type: "idle", why: "landed_or_stopped" });
    }
  });

  it("row 8: a waking unshown heads-up is shown before the model call (TL5)", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.inbox.push({ heads_up: hu(1), shown_step: null, received_at: 0 });
    const action = nextAction(state, CFG);
    expect(action.type).toBe("show_heads_ups");
    if (action.type === "show_heads_ups") expect(action.heads_ups.map((h) => h.hn)).toEqual([1]);
  });

  it("row 6: while waiting, a waking run gets a user row; an info heads-up alone waits (HE2)", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.meta.state = "validated";
    state.inbox.push({ heads_up: hu(1, { result: "info", wake: false }), shown_step: null, received_at: 0 });
    expect(nextAction(state, CFG)).toEqual({ type: "idle", why: "waiting" });
    state.inbox.push({ heads_up: hu(2), shown_step: null, received_at: 0 });
    const action = nextAction(state, CFG);
    expect(action.type).toBe("show_heads_ups");
    if (action.type === "show_heads_ups") expect(action.heads_ups.map((h) => h.hn)).toEqual([1, 2]);
  });
});

describe("TL7: a reply with no tool call is nudged; MAX_NUDGES in a row stops with no_tool_call", () => {
  it("assistant row with no calls -> nudge, then model call; MAX_NUDGES -> stop", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    assistant(state, []);
    const nudge = nextAction(state, CFG);
    expect(nudge.type).toBe("nudge");
    if (nudge.type === "nudge") writeUserRow(state, nudge.text, 0);
    expect(nextAction(state, CFG).type).toBe("model");
    assistant(state, []);
    const last = nextAction(state, CFG);
    expect(last).toEqual({ type: "stop", reason: "model_error:no_tool_call" });
  });

  it("a reply cut at length gets texts.nudge_cut", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    assistant(state, [], "length");
    const action = nextAction(state, CFG);
    expect(action.type).toBe("nudge");
    if (action.type === "nudge") expect(action.text).toContain("too long");
  });
});

describe("TL8: the calls that stop a reply's processing and answer the rest not_run", () => {
  function multiCallState(): { state: LoopState; calls: ToolCall[] } {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    const calls = assistant(state, [
      ["read", { path: "a.js" }],
      ["read", { path: "b.js" }],
      ["read", { path: "c.js" }],
    ]);
    return { state, calls };
  }

  it("an error tool row stops processing: answer_rest earlier_failed", () => {
    const { state } = multiCallState();
    writeToolRow(state, {
      tool: "read",
      call_id: "a_t:3",
      model_call_id: "call_0",
      args: { path: "a.js" },
      message: toolMessageFor({ error: { code: "not_found" } }),
      counts_step: true,
      started_at: 0,
      ended_at: 0,
    });
    expect(nextAction(state, CFG)).toEqual({ type: "answer_rest", reason: "earlier_failed" });
  });

  it("a tool row carrying a heads-up stops processing: answer_rest heads_up", () => {
    const { state } = multiCallState();
    toolOk(state, "read", { path: "a.js" }, {}, [hu(1)]);
    expect(nextAction(state, CFG)).toEqual({ type: "answer_rest", reason: "heads_up" });
  });

  it("a submit row stops processing: answer_rest after_submit", () => {
    const { state } = multiCallState();
    state.inbox.push({ heads_up: hu(1, { wake: false }), shown_step: null, received_at: 0 });
    state.meta.shown_hn = 1;
    toolOk(state, "submit", { summary: "s" }, { status: "validated" });
    expect(nextAction(state, CFG)).toEqual({ type: "answer_rest", reason: "after_submit" });
  });

  it("MAX_TOOL_CALLS_PER_TURN processed calls stop the rest: answer_rest too_many", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    assistant(
      state,
      Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, (_, i) => ["read", { path: `f${i}.js` }]),
    );
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
      expect(nextAction(state, CFG).type).toBe("tool");
      toolOk(state, "read", { path: `f${i}.js` }, {});
    }
    expect(nextAction(state, CFG)).toEqual({ type: "answer_rest", reason: "too_many" });
  });
});

describe("budgets (4.7)", () => {
  it("MAX_MODEL_CALLS reached -> stop budget", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.meta.model_calls = MAX_MODEL_CALLS;
    expect(nextAction(state, CFG)).toEqual({ type: "stop", reason: "budget" });
  });
  it("tokens at MAX_ATTEMPT_TOKENS -> stop budget", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.meta.tokens_in = MAX_ATTEMPT_TOKENS;
    expect(nextAction(state, CFG)).toEqual({ type: "stop", reason: "budget" });
  });
  it("spend plus this call's reservation bound over MAX_ATTEMPT_USD -> stop budget", () => {
    const state = newLoopState();
    startAttempt(state, "i", 0);
    state.meta.spent_usd = 200;
    expect(nextAction(state, CFG)).toEqual({ type: "stop", reason: "budget" });
  });
  it("toolBudgetOk gates a tool call on MAX_STEPS", () => {
    const state = newLoopState();
    state.meta.tool_steps = MAX_STEPS - 1;
    expect(toolBudgetOk(state)).toBe(true);
    state.meta.tool_steps = MAX_STEPS;
    expect(toolBudgetOk(state)).toBe(false);
  });
});

describe("row writing and heads-up delivery (TL9, TL14, MR4)", () => {
  it("writeToolRow raises shown_hn for the heads-ups the message carries", () => {
    const state = newLoopState();
    state.inbox.push({ heads_up: hu(1), shown_step: null, received_at: 0 });
    toolOk(state, "read", { path: "a.js" }, {}, [hu(1)]);
    expect(state.meta.shown_hn).toBe(1);
    expect(state.inbox[0]?.shown_step).toBe(1);
  });

  it("writeUserRow raises shown_hn for the heads-ups the SP5 message holds", () => {
    const state = newLoopState();
    state.inbox.push({ heads_up: hu(1), shown_step: null, received_at: 0 });
    writeUserRow(state, headsUpMessage([hu(1)]), 0);
    expect(state.meta.shown_hn).toBe(1);
    expect(state.inbox[0]?.shown_step).toBe(1);
  });

  it("messageForResponse: response heads-ups enter the inbox and ride the message (MR4)", () => {
    const state = newLoopState();
    const { message, needsSync } = messageForResponse(state, response({ heads_ups: [hu(1)] }));
    expect(message.heads_ups?.map((h) => h.hn)).toEqual([1]);
    expect(needsSync).toBe(false);
    expect(state.inbox).toHaveLength(1);
  });

  it("messageForResponse: heads_ups_more or an inbox gap asks for a sync (MR4)", () => {
    const state = newLoopState();
    expect(messageForResponse(state, response({ heads_ups_more: true })).needsSync).toBe(true);
    const gapped = newLoopState();
    gapped.inbox.push({ heads_up: hu(5), shown_step: null, received_at: 0 });
    expect(messageForResponse(gapped, response({})).needsSync).toBe(true);
  });

  it("unshownRun reports the run, the sync need and the wake", () => {
    const state = newLoopState();
    state.inbox.push({ heads_up: hu(1, { wake: false }), shown_step: null, received_at: 0 });
    state.inbox.push({ heads_up: hu(2), shown_step: null, received_at: 0 });
    const run = unshownRun(state);
    expect(run.show.map((h) => h.hn)).toEqual([1, 2]);
    expect(run.sync).toBe(false);
    expect(run.wake).toBe(true);
  });
});
