// The model call on the wire (TL2/MP1), the answer parse (TL3) and the money arithmetic (TL4, SE6).

import { describe, it, expect } from "vitest";
import { parseModelAnswer, buildModelRequest, costUsd, reservationBound } from "./model.ts";
import { TOOL_DEFINITIONS } from "../../../protocol/agent-prompt.ts";
import { MODEL_MAX_TOKENS } from "../../../protocol/constants.ts";

const CHOICE_SHAPE = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: { path: "a.js" } } }],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

describe("parseModelAnswer (TL3)", () => {
  it("reads choices[0].message: content, tool_calls, finish_reason and usage", () => {
    const out = parseModelAnswer(CHOICE_SHAPE, 3);
    expect(out).not.toBeNull();
    expect(out?.content).toBe("");
    expect(out?.tool_calls).toHaveLength(1);
    expect(out?.tool_calls[0]?.function.name).toBe("read");
    expect(out?.finish_reason).toBe("stop");
    expect(out?.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
  });
  it("accepts the older { response, tool_calls: [{ name, arguments }] } shape", () => {
    const out = parseModelAnswer({ response: "hi", tool_calls: [{ name: "read", arguments: { path: "a.js" } }] }, 3);
    expect(out?.content).toBe("hi");
    expect(out?.tool_calls[0]?.function.name).toBe("read");
    expect(out?.tool_calls[0]?.function.arguments).toEqual({ path: "a.js" });
  });
  it("gives a call without id the id call_<row>_<index>", () => {
    const out = parseModelAnswer(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { function: { name: "read", arguments: {} } },
                { function: { name: "list", arguments: {} } },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
      9,
    );
    expect(out?.tool_calls[0]?.id).toBe("call_9_0");
    expect(out?.tool_calls[1]?.id).toBe("call_9_1");
  });
  it("stores '{}' as arguments and the first 200 characters as received when arguments are not JSON (TD4)", () => {
    const bad = `{${"x".repeat(300)}`;
    const out = parseModelAnswer(
      {
        choices: [
          {
            message: { content: "", tool_calls: [{ id: "c", function: { name: "read", arguments: bad } }] },
            finish_reason: "stop",
          },
        ],
      },
      1,
    );
    const call = out?.tool_calls[0];
    expect(call?.function.arguments).toBe("{}");
    expect(call?.received).toBe(bad.slice(0, 200));
  });
  it.each([
    ["a string", "not an object"],
    ["an empty object", {}],
    ["choices without a message", { choices: [{}] }],
    ["non-string content", { choices: [{ message: { content: 4 } }] }],
    [
      "a call without a name",
      { choices: [{ message: { content: "", tool_calls: [{ function: { arguments: {} } }] } }] },
    ],
  ])("returns null (model_bad_output) for %s", (_name, raw) => {
    expect(parseModelAnswer(raw, 1)).toBeNull();
  });
  it("content absent or null becomes the empty string (MP1)", () => {
    expect(parseModelAnswer({ choices: [{ message: { tool_calls: [] } }] }, 1)?.content).toBe("");
    expect(parseModelAnswer({ choices: [{ message: { content: null } }] }, 1)?.content).toBe("");
  });
  it("usage without both token counts is null (settled at the bound, SE6a)", () => {
    expect(
      parseModelAnswer({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 5 } }, 1)?.usage,
    ).toBeNull();
  });
  it("stores reasoning text, which is never sent back (TL3)", () => {
    const out = parseModelAnswer({ choices: [{ message: { content: "", reasoning: "thinking" } }] }, 1);
    expect(out?.reasoning).toBe("thinking");
  });
});

describe("buildModelRequest (TL2/MP1)", () => {
  it("sends messages, TOOL_DEFINITIONS, MODEL_MAX_TOKENS and the model options — nothing else", () => {
    const request = buildModelRequest({
      messages: [{ role: "system", content: "s" }],
      options: { reasoning_effort: "low" },
    });
    expect(Object.keys(request).sort()).toEqual(["max_tokens", "messages", "reasoning_effort", "tools"]);
    expect(request.tools).toBe(TOOL_DEFINITIONS);
    expect(request.max_tokens).toBe(MODEL_MAX_TOKENS);
    expect(request.reasoning_effort).toBe("low");
  });
});

describe("money (TL4, SE6)", () => {
  const price = { input: 0.35, output: 0.75 };
  it("costUsd = (tokens_in x input + tokens_out x output) / 1,000,000", () => {
    expect(costUsd(1_000_000, 1_000_000, price)).toBeCloseTo(1.1);
    expect(costUsd(1000, 500, price)).toBeCloseTo(0.000725);
  });
  it("reservationBound = request bytes x input price + max_tokens x output price", () => {
    expect(reservationBound(1_000_000, 0, price)).toBeCloseTo(0.35);
    expect(reservationBound(0, 1_000_000, price)).toBeCloseTo(0.75);
  });
});
