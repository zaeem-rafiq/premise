// `assembleMessages` (4.3) and the trimming of 4.4: CX1's stub, CX2's heads-up rule, CX3's pins,
// CX4's order and CX5's hard limit. Rows are built through the loop's own writers.

import { describe, it, expect } from "vitest";
import { assembleMessages } from "./context.ts";
import { newLoopState } from "./state.ts";
import { appendRow } from "./state.ts";
import type { LoopState } from "./state.ts";
import type { ToolCall } from "./rows.ts";
import { GUIDE_PATH, importedFills, systemPrompt, firstUserMessage } from "../../../protocol/agent-prompt.ts";
import { CONTEXT_TARGET_CHARS, CONTEXT_HARD_CHARS, CONTEXT_KEEP_TURNS } from "../../../protocol/constants.ts";
import { TEXTS } from "./texts.ts";

function asst(state: LoopState, calls: Array<[string, object]>): void {
  const toolCalls: ToolCall[] = calls.map(([name, args], i) => ({
    id: `call_${state.rows.length}_${i}`,
    type: "function",
    function: { name, arguments: args },
  }));
  appendRow(state, {
    role: "assistant",
    content: JSON.stringify({ content: "", tool_calls: toolCalls, finish_reason: "stop" }),
    tool: null,
    call_id: null,
    model: "m",
    tokens_in: null,
    tokens_out: null,
    started_at: 0,
    ended_at: 0,
  });
}

function toolResult(state: LoopState, tool: string, args: object, result: object): void {
  appendRow(state, {
    role: "tool",
    content: JSON.stringify({
      message: { result },
      trunk_error: null,
      args,
      model_call_id: `call_${state.rows.length - 1}_0`,
    }),
    tool,
    call_id: `a_t:${state.rows.length}`,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: 0,
    ended_at: 0,
  });
}

function turn(state: LoopState, tool: string, args: object, result: object): void {
  asst(state, [[tool, args]]);
  toolResult(state, tool, args, result);
}

function start(state: LoopState): void {
  appendRow(state, {
    role: "system",
    content: systemPrompt(),
    tool: null,
    call_id: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: 0,
    ended_at: null,
  });
  appendRow(state, {
    role: "user",
    content: firstUserMessage("test intent"),
    tool: null,
    call_id: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: 0,
    ended_at: null,
  });
}

const BIG = "x".repeat(30_000);

describe("assembleMessages (4.3)", () => {
  it("maps roles to wire shapes; assistant tool_calls left out when empty", () => {
    const state = newLoopState();
    start(state);
    appendRow(state, {
      role: "assistant",
      content: JSON.stringify({ content: "hello", tool_calls: [], finish_reason: "stop" }),
      tool: null,
      call_id: null,
      model: "m",
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.messages[0]).toEqual({ role: "system", content: systemPrompt() });
    expect(out.messages[1]).toEqual({ role: "user", content: firstUserMessage("test intent") });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "hello" });
    expect("tool_calls" in (out.messages[2] as object)).toBe(false);
  });

  it("a tool row becomes { role: tool, tool_call_id: <model call id>, content: <MR1 JSON> }", () => {
    const state = newLoopState();
    start(state);
    asst(state, [["read", { path: "a.js" }]]);
    appendRow(state, {
      role: "tool",
      content: JSON.stringify({
        message: { result: { path: "a.js", content: "code" } },
        trunk_error: null,
        args: { path: "a.js" },
        model_call_id: "call_xyz",
      }),
      tool: "read",
      call_id: "a_t:3",
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const msg = out.messages[3] as { role: string; tool_call_id: string; content: string };
    expect(msg.role).toBe("tool");
    expect(msg.tool_call_id).toBe("call_xyz");
    expect(JSON.parse(msg.content)).toEqual({ result: { path: "a.js", content: "code" } });
  });
});

describe("CX1/CX4: only read-tool results are elided, in the spec's order, with the spec's stub", () => {
  it("a read result a later identical call replaced goes before every other unpinned read (CX4)", () => {
    const state = newLoopState();
    start(state);
    // 5 turns; the last CONTEXT_KEEP_TURNS (3) are pinned: turns 3,4,5. Removing turn 1's result
    // alone brings the request under the target, so the elided set records which group went first:
    // only the replaced read goes. If the "others" group went first the set would be [4, 6].
    turn(state, "read", { path: "a.js" }, { content: "x".repeat(CONTEXT_TARGET_CHARS) }); // turn 1: replaced by turn 3
    turn(state, "read", { path: "b.js" }, { content: "small" }); // turn 2: unpinned, kept
    turn(state, "read", { path: "a.js" }, { content: "small2" }); // turn 3: pinned
    turn(state, "read", { path: "c.js" }, { content: "small3" }); // turn 4: pinned
    turn(state, "read", { path: "d.js" }, { content: "small4" }); // turn 5: pinned
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.elided_steps).toEqual([4]);
    const stub = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    expect(stub.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
  });

  it("several replaced and unpinned reads: the stub shape and the whole elided run (CX1, CX4)", () => {
    const state = newLoopState();
    start(state);
    turn(state, "read", { path: "a.js" }, { content: BIG }); // turn 1: replaced by turn 2
    turn(state, "read", { path: "a.js" }, { content: BIG + "b" }); // turn 2: unpinned
    turn(state, "read", { path: "b.js" }, { content: BIG }); // turn 3: pinned
    turn(state, "read", { path: "c.js" }, { content: BIG }); // turn 4: pinned
    turn(state, "read", { path: "d.js" }, { content: BIG }); // turn 5: pinned
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // turns 1 and 2 are the only elidable unpinned rows (tool rows at steps 4 and 6); both go.
    expect(out.elided_steps).toEqual([4, 6]);
    const stub1 = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    const stub2 = JSON.parse((out.messages[5] as { content: string }).content) as Record<string, unknown>;
    expect(stub1.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
    expect(stub2.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
  });

  it("write and submit results are never elided", () => {
    const state = newLoopState();
    start(state);
    turn(state, "read", { path: "a.js" }, { content: BIG });
    turn(state, "write", { path: "a.js" }, { op_seq: 1, big: BIG });
    turn(state, "read", { path: "b.js" }, { content: BIG });
    turn(state, "submit", { summary: "s" }, { status: "validated", big: BIG });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const texts = out.messages.map((m) => (m as { content: string }).content);
    expect(texts.some((t) => t.includes(BIG))).toBe(true); // write/submit results survive
  });
});

describe("CX3 pins", () => {
  it("the newest answered whole-file read of GUIDE.md is pinned even when oldest", () => {
    const state = newLoopState();
    start(state);
    turn(state, "read", { path: GUIDE_PATH }, { path: GUIDE_PATH, content: BIG }); // turn 1: guide pin
    turn(state, "read", { path: "a.js" }, { content: BIG }); // turn 2: unpinned
    turn(state, "read", { path: "b.js" }, { content: BIG }); // turn 3: pinned
    turn(state, "read", { path: "c.js" }, { content: BIG }); // turn 4: pinned
    turn(state, "read", { path: "d.js" }, { content: BIG }); // turn 5: pinned
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Only the unpinned read of turn 2 can be elided; the guide read survives.
    const guideMsg = out.messages[3] as { content: string };
    expect(guideMsg.content).toContain(BIG);
    const elided = JSON.parse((out.messages[5] as { content: string }).content) as Record<string, unknown>;
    expect(elided.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
  });

  it("an entity read of GUIDE.md is not the pinned whole-file read", () => {
    const state = newLoopState();
    start(state);
    turn(state, "read", { path: GUIDE_PATH, entity: "(top)" }, { source: BIG }); // not whole-file: unpinned
    turn(state, "read", { path: "a.js" }, { content: BIG });
    turn(state, "read", { path: "b.js" }, { content: BIG });
    turn(state, "read", { path: "c.js" }, { content: BIG });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const elided = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    expect(elided.result).toEqual({ elided: true, tool: "read", target: `${GUIDE_PATH}#(top)`, note: TEXTS.elided });
  });
});

describe("CX3 on an imported pool (06-repos IR9)", () => {
  // The pool's guide is the path the import found — here AGENTS.md; a pool with no guide file
  // pins nothing.
  const IMPORTED = importedFills({ guide_path: "AGENTS.md", source: "ai/nanoid", branch: "main" });
  const NO_GUIDE = importedFills({ guide_path: "", source: "ai/nanoid", branch: "main" });

  it("the newest answered whole-file read of the pool's guide_path is pinned", () => {
    const state = newLoopState(IMPORTED);
    start(state);
    turn(state, "read", { path: "AGENTS.md" }, { path: "AGENTS.md", content: BIG }); // turn 1: guide pin
    turn(state, "read", { path: "a.js" }, { content: BIG }); // turn 2: unpinned
    turn(state, "read", { path: "b.js" }, { content: BIG }); // turn 3: pinned
    turn(state, "read", { path: "c.js" }, { content: BIG }); // turn 4: pinned
    turn(state, "read", { path: "d.js" }, { content: BIG }); // turn 5: pinned
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const guideMsg = out.messages[3] as { content: string };
    expect(guideMsg.content).toContain(BIG);
    const elided = JSON.parse((out.messages[5] as { content: string }).content) as Record<string, unknown>;
    expect(elided.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
  });

  it("a whole-file read of GUIDE.md is not the imported pool's guide pin", () => {
    const state = newLoopState(IMPORTED);
    start(state);
    turn(state, "read", { path: GUIDE_PATH }, { path: GUIDE_PATH, content: BIG }); // not the guide
    turn(state, "read", { path: "a.js" }, { content: BIG });
    turn(state, "read", { path: "b.js" }, { content: BIG });
    turn(state, "read", { path: "c.js" }, { content: BIG });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The GUIDE.md read is the oldest elidable row and nothing pins it.
    const elided = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    expect(elided.result).toEqual({ elided: true, tool: "read", target: GUIDE_PATH, note: TEXTS.elided });
  });

  it("a guide-less imported pool pins no guide read", () => {
    const state = newLoopState(NO_GUIDE);
    start(state);
    turn(state, "read", { path: "AGENTS.md" }, { path: "AGENTS.md", content: BIG }); // no pin for it
    turn(state, "read", { path: "a.js" }, { content: BIG });
    turn(state, "read", { path: "b.js" }, { content: BIG });
    turn(state, "read", { path: "c.js" }, { content: BIG });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const elided = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    expect(elided.result).toEqual({ elided: true, tool: "read", target: "AGENTS.md", note: TEXTS.elided });
  });
});

describe("CX2: a heads-up is never elided or shortened", () => {
  it("an elided row keeps its heads_ups", () => {
    const state = newLoopState();
    start(state);
    asst(state, [["read", { path: "a.js" }]]);
    appendRow(state, {
      role: "tool",
      content: JSON.stringify({
        message: {
          heads_ups: [{ hn: 1, action: "repair", because: "b", changed_by: "c", items: [], dropped_edits: [] }],
          result: { content: BIG },
        },
        trunk_error: null,
        args: { path: "a.js" },
        model_call_id: "call_x",
      }),
      tool: "read",
      call_id: "a_t:3",
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    turn(state, "read", { path: "b.js" }, { content: BIG });
    turn(state, "read", { path: "c.js" }, { content: BIG });
    turn(state, "read", { path: "d.js" }, { content: BIG });
    const out = assembleMessages(state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const msg = JSON.parse((out.messages[3] as { content: string }).content) as Record<string, unknown>;
    expect(Array.isArray(msg.heads_ups)).toBe(true);
    expect((msg.heads_ups as object[]).length).toBe(1);
    expect(msg.result).toEqual({ elided: true, tool: "read", target: "a.js", note: TEXTS.elided });
  });
});

describe("CX5: the hard limit", () => {
  it("context still over CONTEXT_HARD_CHARS after elision -> no model call (ok: false)", () => {
    const state = newLoopState();
    start(state);
    appendRow(state, {
      role: "assistant",
      content: JSON.stringify({ content: "y".repeat(CONTEXT_HARD_CHARS + 10), tool_calls: [], finish_reason: "stop" }),
      tool: null,
      call_id: null,
      model: "m",
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    const out = assembleMessages(state);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("context_overflow");
  });
});

it("CX4: elision stops as soon as the request is at or under CONTEXT_TARGET_CHARS", () => {
  const state = newLoopState();
  start(state);
  // One oversized result pushes over the target; leaving it out brings the request back under.
  turn(state, "read", { path: "a.js" }, { content: "x".repeat(CONTEXT_TARGET_CHARS) });
  turn(state, "read", { path: "b.js" }, { content: "small" });
  turn(state, "read", { path: "c.js" }, { content: "small2" });
  turn(state, "read", { path: "d.js" }, { content: "small3" });
  turn(state, "read", { path: "e.js" }, { content: "small4" });
  const out = assembleMessages(state);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(JSON.stringify(out.messages).length).toBeLessThanOrEqual(CONTEXT_TARGET_CHARS);
  expect(out.elided_steps).toEqual([4]);
});
