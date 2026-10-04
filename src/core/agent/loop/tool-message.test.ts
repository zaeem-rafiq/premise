// The tool message of MR1 to MR4: compact JSON with the fixed key order, result unchanged (MR2),
// and the error message from the fixed texts, never Trunk's (MR3).

import { describe, it, expect } from "vitest";
import { toolMessageFor, renderToolMessage, errorForModel } from "./tool-message.ts";
import { AGENT_TEXTS } from "../../../protocol/agent-prompt.ts";

const ERRORS = (JSON.parse(AGENT_TEXTS) as { errors: Record<string, string> }).errors;

const HU = { hn: 1, action: "repair" as const, because: "b", changed_by: null, items: [], dropped_edits: [] };

describe("MR1: the message and its key order", () => {
  it("is compact JSON with keys heads_ups, result, error in that order", () => {
    const message = toolMessageFor({ result: { a: 1 }, heads_ups: [HU] });
    const text = renderToolMessage(message);
    expect(text).toBe(JSON.stringify({ heads_ups: [HU], result: { a: 1 } }));
    expect(text.indexOf('"heads_ups"')).toBeLessThan(text.indexOf('"result"'));
  });
  it("heads_ups is left out when empty", () => {
    expect(renderToolMessage(toolMessageFor({ result: {}, heads_ups: [] }))).toBe('{"result":{}}');
  });
  it("exactly one of result and error is present", () => {
    const withError = renderToolMessage(toolMessageFor({ error: { code: "not_found" } }));
    expect(JSON.parse(withError)).toEqual({ error: { code: "not_found", message: ERRORS.not_found } });
    const withResult = renderToolMessage(toolMessageFor({ result: { x: 1 } }));
    expect(Object.keys(JSON.parse(withResult))).toEqual(["result"]);
  });
});

describe("MR2: result is ToolResponse.result unchanged", () => {
  it("no field is added, removed or renamed", () => {
    const result = { path: "a.js", oid: "o", nested: { k: [1, 2] }, premises_like_name: "kept" };
    const message = toolMessageFor({ result });
    expect(JSON.parse(renderToolMessage(message)).result).toEqual(result);
  });
});

describe("MR3: the error a model reads", () => {
  it("error.message is the sentence of 3.6 for the code, not Trunk's text", () => {
    const error = errorForModel("heads_up_first");
    expect(error).toEqual({ code: "heads_up_first", message: ERRORS.heads_up_first });
  });
  it("error.detail is passed through", () => {
    expect(errorForModel("bad_arguments", { argument: "path", problem: "missing" }).detail).toEqual({
      argument: "path",
      problem: "missing",
    });
  });
  it("an unknown code gets the 'other' sentence", () => {
    expect(errorForModel("something_new").message).toBe(ERRORS.other);
  });
  it("guide_first's sentence names GUIDE.md", () => {
    expect(errorForModel("guide_first").message).toContain("GUIDE.md");
  });
});
