// The scripted fake model: deterministic, intent-aware, answers in the Workers AI shape. It is
// what --dry-run and the no-network tests run against — its files must satisfy the same checks
// (spawn/update/draw as exported functions, resolving imports) as a real model's.

import { describe, it, expect } from "vitest";
import { cannedModel } from "./fake-model.ts";
import { ADDITIVE_INTENTS, HERO_INTENTS } from "./intents.ts";
import { scoreCompleted, checkTree } from "./score.ts";
import { loadSeed } from "../models.ts";

type ToolCall = { id: string; function: { name: string; arguments: string } };
async function callsOf(model: ReturnType<typeof cannedModel>, messages: object[] = []): Promise<ToolCall[]> {
  const out = await model({ messages });
  if (out.kind !== "answer") throw new Error(`expected answer, got ${out.kind}`);
  const msg = (out.result as { choices: Array<{ message: { tool_calls?: ToolCall[] } }> }).choices[0]!.message;
  return msg.tool_calls ?? [];
}

describe("the canned strategy", () => {
  it("reads the guide first, writes the intent's file, then submits", async () => {
    const model = cannedModel(ADDITIVE_INTENTS[0]!);
    const first = await callsOf(model);
    expect(first[0]?.function.name).toBe("read");
    expect(JSON.parse(first[0]!.function.arguments)).toEqual({ path: "GUIDE.md" });
    const second = await callsOf(model);
    expect(second[0]?.function.name).toBe("write");
    expect(JSON.parse(second[0]!.function.arguments).path).toBe("creatures/jellyfish.js");
    const third = await callsOf(model);
    expect(third[0]?.function.name).toBe("submit");
  });

  it("answers in the Workers AI envelope shape TL3 parses", async () => {
    const out = await cannedModel(ADDITIVE_INTENTS[0]!)({ messages: [] });
    if (out.kind !== "answer") throw new Error("expected an answer");
    const result = out.result as {
      choices: Array<{ message: { content: string; tool_calls: ToolCall[] }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("after a heads-up it makes the intent's repair, then submits with a statement", async () => {
    const model = cannedModel(HERO_INTENTS[0]!);
    await callsOf(model); // read
    await callsOf(model); // write
    await callsOf(model); // first submit (no heads-up seen)
    const hu = [{ role: "tool", content: JSON.stringify({ heads_ups: [{ hn: 1 }] }) }];
    const repair = await callsOf(model, hu);
    expect(repair[0]?.function.name).toBe("replace");
    expect(JSON.parse(repair[0]!.function.arguments)).toEqual({
      path: "creatures/crab.js",
      old: "crab.energy < 30",
      new: "crab.energy < 0.3",
    });
    const submit = await callsOf(model, hu);
    const args = JSON.parse(submit[0]!.function.arguments);
    expect(submit[0]?.function.name).toBe("submit");
    expect(typeof args.statement).toBe("string");
  });

  it("its canned files pass the same completion checks as a real model's", async () => {
    // Reproduce what the canned model writes: drive it once through a capture.
    for (const intent of [...ADDITIVE_INTENTS.slice(0, 3), ...HERO_INTENTS]) {
      const model = cannedModel(intent);
      await callsOf(model); // read
      const write = await callsOf(model); // write
      const content = JSON.parse(write[0]!.function.arguments).content as string;
      const files = new Map<string, string>([...loadSeed(), [intent.writes, content]]);
      expect(checkTree(files).ok, `${intent.id} tree`).toBe(true);
      expect(
        scoreCompleted({ files, seedPaths: new Set(loadSeed().keys()), writes: intent.writes, passedSubmit: true }),
        intent.id,
      ).toBe("completed");
    }
  });
});
