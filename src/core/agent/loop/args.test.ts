// From a model's tool call to a ToolRequest: the three normalizations of TD3, the refusals of TD4,
// the guide-first rule of TD5 and the acknowledge/statement rule of TD6.

import { describe, it, expect } from "vitest";
import {
  normalizeArgs,
  validateArgs,
  parseCallArguments,
  processCall,
  submitAcknowledge,
  callTarget,
  guideRead,
} from "./args.ts";
import { newLoopState, appendRow, type LoopState } from "./state.ts";
import { GUIDE_PATH } from "../../../protocol/agent-prompt.ts";
import { MAX_STATEMENT_CHARS } from "../../../protocol/constants.ts";
import type { ToolCall } from "./rows.ts";

function callOf(name: string, args: unknown): ToolCall {
  return { id: "call_1", type: "function", function: { name, arguments: args } };
}

function stateWithGuideRead(): LoopState {
  const state = newLoopState();
  appendRow(state, {
    role: "tool",
    content: JSON.stringify({
      message: { result: { path: GUIDE_PATH } },
      trunk_error: null,
      args: { path: GUIDE_PATH },
      model_call_id: "call_1",
    }),
    tool: "read",
    call_id: "a_t:1",
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: 0,
    ended_at: 0,
  });
  return state;
}

describe("TD3 N1: leading ./ or / of a file path is removed; '/' alone stays", () => {
  it.each([
    ["./world/energy.js", "world/energy.js"],
    ["/world/energy.js", "world/energy.js"],
    ["./a/b.js", "a/b.js"],
    ["/", "/"],
    ["world/energy.js", "world/energy.js"],
  ])("read path %s -> %s", (input, expected) => {
    expect(normalizeArgs("read", { path: input }).path).toBe(expected);
  });
});

describe("TD3 N2: a list path gets a trailing /", () => {
  it.each([
    ["creatures", "creatures/"],
    ["creatures/", "creatures/"],
    ["/", "/"],
  ])("list path %s -> %s", (input, expected) => {
    expect(normalizeArgs("list", { path: input }).path).toBe(expected);
  });
});

describe("TD3 N3: a # in the path of read or outline splits at the first #", () => {
  it("read: the part after # becomes entity when none was given", () => {
    expect(normalizeArgs("read", { path: "world/energy.js#ENERGY_MAX" })).toEqual({
      path: "world/energy.js",
      entity: "ENERGY_MAX",
    });
  });
  it("read: an explicit entity wins; the # stays in path", () => {
    expect(normalizeArgs("read", { path: "a.js#E", entity: "F" })).toEqual({ path: "a.js#E", entity: "F" });
  });
  it("outline: the part after # is dropped", () => {
    expect(normalizeArgs("outline", { path: "world/energy.js#ENERGY_MAX" })).toEqual({
      path: "world/energy.js",
    });
  });
});

describe("TD3: no other change is made; unknown arguments are kept for the request", () => {
  it("leaves unknown arguments in place (TD4: ignored later)", () => {
    const out = normalizeArgs("read", { path: "a.js", surprise: 1 });
    expect(out.surprise).toBe(1);
  });
  it("write with delete: false drops the key (TD2)", () => {
    expect(normalizeArgs("write", { path: "a.js", content: "x", delete: false })).toEqual({
      path: "a.js",
      content: "x",
    });
  });
});

describe("TD4 bad_arguments: missing, empty, wrong type, conflict, too_long", () => {
  it.each([
    ["read", {}, { argument: "path", problem: "missing" }],
    ["read", { path: "" }, { argument: "path", problem: "empty" }],
    ["read", { path: 5 }, { argument: "path", problem: "wrong_type" }],
    ["replace", { path: "a.js", old: "x" }, { argument: "new", problem: "missing" }],
    ["submit", {}, { argument: "summary", problem: "missing" }],
    ["search", { query: "energy" }, null],
    ["read", { path: "a.js", entity: 3 }, { argument: "entity", problem: "wrong_type" }],
    ["write", { path: "a.js", content: "x", delete: true }, { argument: "content", problem: "conflict" }],
    ["write", { path: "a.js", content: "x", delete: "yes" }, { argument: "delete", problem: "wrong_type" }],
    ["write", { path: "a.js" }, { argument: "content", problem: "missing" }],
    [
      "submit",
      { summary: "s", statement: "x".repeat(MAX_STATEMENT_CHARS + 1) },
      { argument: "statement", problem: "too_long" },
    ],
    ["submit", { summary: "s", statement: "x".repeat(MAX_STATEMENT_CHARS) }, null],
  ])("%s %o -> %o", (tool, args, expected) => {
    expect(validateArgs(tool as never, args)).toEqual(expected);
  });
});

describe("parseCallArguments (TD3)", () => {
  it("accepts an object as it is", () => {
    expect(parseCallArguments({ path: "a.js" })).toEqual({ ok: true, args: { path: "a.js" } });
  });
  it("parses JSON text of an object", () => {
    expect(parseCallArguments('{"path":"a.js"}')).toEqual({ ok: true, args: { path: "a.js" } });
  });
  it("rejects non-object JSON and keeps the first 200 characters as received", () => {
    expect(parseCallArguments('["a","b"]')).toEqual({ ok: false, received: '["a","b"]' });
    const long = `{${"x".repeat(500)}`;
    const out = parseCallArguments(long);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.received).toBe(long.slice(0, 200));
  });
});

describe("processCall (TD4 refusal order)", () => {
  it("unknown_tool for a name outside the seven", () => {
    const out = processCall(newLoopState(), callOf("exec", {}), null);
    expect(out).toEqual({ kind: "error", code: "unknown_tool", detail: { name: "exec" } });
  });
  it("bad_arguments with received when arguments are not JSON", () => {
    const out = processCall(newLoopState(), callOf("read", "{oops"), null);
    expect(out).toEqual({
      kind: "error",
      code: "bad_arguments",
      detail: { argument: "arguments", problem: "not_json", received: "{oops" },
    });
  });
  it("output_cut instead of bad_arguments when finish_reason is length", () => {
    const out = processCall(newLoopState(), callOf("read", "{oops"), "length");
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("output_cut");
      expect(out.detail).toEqual({ max_tokens: expect.any(Number) });
    }
  });
  it("output_cut also covers a valid-JSON argument problem under finish_reason length", () => {
    const out = processCall(newLoopState(), callOf("read", {}), "length");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("output_cut");
  });
});

describe("TD5 guide_first: write, replace and submit before an answered whole-file GUIDE.md read", () => {
  it.each(["write", "replace", "submit"])("%s is refused with guide_first before the read", (tool) => {
    const args =
      tool === "write"
        ? { path: "a.js", content: "x" }
        : tool === "replace"
          ? { path: "a.js", old: "x", new: "y" }
          : { summary: "s" };
    const out = processCall(newLoopState(), callOf(tool, args), null);
    expect(out).toEqual({ kind: "error", code: "guide_first", detail: { path: GUIDE_PATH } });
  });
  it("read tools are not refused before the guide read", () => {
    const out = processCall(newLoopState(), callOf("read", { path: "a.js" }), null);
    expect(out.kind).toBe("request");
  });
  it("write is allowed after the answered read of GUIDE.md", () => {
    const out = processCall(stateWithGuideRead(), callOf("write", { path: "a.js", content: "x" }), null);
    expect(out.kind).toBe("request");
  });
  it("an entity read of GUIDE.md does not satisfy TD5", () => {
    const state = newLoopState();
    appendRow(state, {
      role: "tool",
      content: JSON.stringify({
        message: { result: { key: `${GUIDE_PATH}#(top)` } },
        trunk_error: null,
        args: { path: GUIDE_PATH, entity: "(top)" },
        model_call_id: "call_1",
      }),
      tool: "read",
      call_id: "a_t:1",
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    expect(guideRead(state)).toBe(false);
  });
  it("a TD4 refusal row (no call_id) does not satisfy TD5", () => {
    const state = newLoopState();
    appendRow(state, {
      role: "tool",
      content: JSON.stringify({
        message: { error: { code: "bad_arguments", message: "" } },
        trunk_error: null,
        args: { path: GUIDE_PATH },
        model_call_id: "call_1",
      }),
      tool: "read",
      call_id: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    expect(guideRead(state)).toBe(false);
  });
  it("an error answer from Trunk still satisfies TD5 ('with the file, or with an error')", () => {
    const state = newLoopState();
    appendRow(state, {
      role: "tool",
      content: JSON.stringify({
        message: { error: { code: "not_found", message: "" } },
        trunk_error: null,
        args: { path: GUIDE_PATH },
        model_call_id: "call_1",
      }),
      tool: "read",
      call_id: "a_t:1",
      model: null,
      tokens_in: null,
      tokens_out: null,
      started_at: 0,
      ended_at: 0,
    });
    expect(guideRead(state)).toBe(true);
  });
});

describe("TD6 acknowledge and statement", () => {
  function stateWithShownRepair(hn: number, result: "confirm" | "repair" | "info" = "repair"): LoopState {
    const state = stateWithGuideRead();
    state.inbox.push({
      heads_up: {
        hn,
        attempt_id: "a_t",
        result,
        wake: true,
        cause: { type: "landing", seqs: [1], changes: [] },
        items: [],
        dropped_ops: [],
        go_around: 1,
        head_seq: 1,
        created_at: 0,
      },
      shown_step: 1,
      received_at: 0,
    });
    state.meta.shown_hn = hn;
    return state;
  }

  it("submit carries acknowledge = confirm/repair heads-ups with acked_hn < hn <= shown_hn", () => {
    const state = stateWithShownRepair(2);
    const out = processCall(state, callOf("submit", { summary: "s", statement: "done" }), null);
    expect(out.kind).toBe("request");
    if (out.kind === "request") {
      expect((out.args as { acknowledge: number[] }).acknowledge).toEqual([2]);
    }
  });
  it("an info heads-up does not enter acknowledge", () => {
    const state = stateWithShownRepair(1, "info");
    expect(submitAcknowledge(state)).toEqual([]);
  });
  it("a shown heads-up under acked_hn does not enter acknowledge", () => {
    const state = stateWithShownRepair(1);
    state.meta.acked_hn = 1;
    expect(submitAcknowledge(state)).toEqual([]);
  });
  it("a heads-up above shown_hn does not enter acknowledge", () => {
    const state = stateWithShownRepair(3);
    state.meta.shown_hn = 2;
    expect(submitAcknowledge(state)).toEqual([]);
  });
  it("statement_required when acknowledge is non-empty and no statement was given", () => {
    const state = stateWithShownRepair(1);
    const out = processCall(state, callOf("submit", { summary: "s" }), null);
    expect(out).toEqual({ kind: "error", code: "statement_required", detail: { heads_ups: [1] } });
  });
  it("statement_required when the statement is empty", () => {
    const state = stateWithShownRepair(1);
    const out = processCall(state, callOf("submit", { summary: "s", statement: "" }), null);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("statement_required");
  });
  it("a statement with an empty acknowledge list is passed on unchanged", () => {
    const state = stateWithGuideRead();
    const out = processCall(state, callOf("submit", { summary: "s", statement: "kept" }), null);
    expect(out.kind).toBe("request");
    if (out.kind === "request") {
      expect((out.args as { statement: string }).statement).toBe("kept");
      expect((out.args as { acknowledge: number[] }).acknowledge).toEqual([]);
    }
  });
});

describe("callTarget (TL14 target)", () => {
  it.each([
    ["outline", { path: "a.js" }, "a.js"],
    ["read", { path: "a.js" }, "a.js"],
    ["read", { path: "a.js", entity: "E" }, "a.js#E"],
    ["list", { path: "a/" }, "a/"],
    ["search", { query: "foo" }, "foo"],
    ["write", { path: "a.js" }, "a.js"],
    ["replace", { path: "a.js" }, "a.js"],
    ["submit", { summary: "s" }, null],
  ])("%s %o -> %s", (tool, args, expected) => {
    expect(callTarget(tool, args)).toBe(expected);
  });
});
