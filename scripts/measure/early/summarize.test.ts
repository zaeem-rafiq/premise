// The measurement output of 05-agent 6.8: the three pinned protocol hashes, the limits block and
// the per-intent/hero aggregation, built from hand-written RunRecords.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { promptHash, toolsHash, textsHash, percentile, summarize } from "./summarize.ts";

/** The value of the `At this revision` column of the 2.4 row `name`, read from the spec. */
const SPEC = readFileSync(new URL("../../../docs/spec/05-agent.md", import.meta.url), "utf8");
function statedHash(name: string): string {
  const match = new RegExp(`\\|\\s*\`${name}\`\\s*\\|[^|]*\\|\\s*\`([0-9a-f]{32})\`\\s*\\|`).exec(SPEC);
  if (match === null) throw new Error(`the stated ${name} was not found in 05-agent.md 2.4`);
  return match[1] ?? "";
}
import { ADDITIVE_INTENTS, HERO_INTENTS } from "./intents.ts";
import type { RunRecord } from "./run.ts";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_MODEL_CALLS,
  MAX_STEPS,
  MODEL_MAX_TOKENS,
  MODEL_TIMEOUT_MS,
} from "../../../src/protocol/constants.ts";

describe("the pinned protocol hashes (6.8, 2.4)", () => {
  it("prompt_hash is H of the filled system prompt", () => {
    expect(promptHash()).toBe(statedHash("prompt_hash"));
  });
  it("tools_hash is H of the canonical tool definitions", () => {
    expect(toolsHash()).toBe(statedHash("tools_hash"));
  });
  it("texts_hash is H of canonical { first_user, resume, texts }", () => {
    expect(textsHash()).toBe(statedHash("texts_hash"));
    expect(textsHash()).toBe("cc8cf3ff57cfa9b7988f4d2587c52fac");
  });
});

describe("percentile (nearest-rank)", () => {
  it("the value at ⌈p·n⌉ of the sorted values; empty is 0", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.9)).toBe(40);
    expect(percentile([5, 1, 9], 0.5)).toBe(5);
  });
});

const rec = (over: Partial<RunRecord>): RunRecord => ({
  intent: "A01",
  run: 1,
  outcome: "completed",
  stop_reason: null,
  seconds: 2,
  waited_ms: 0,
  model_calls: 3,
  tool_calls: 4,
  tool_errors: 0,
  nudges: 0,
  tokens_in: 120,
  tokens_out: 40,
  cost_usd: 0.0001,
  first_tool: "read GUIDE.md",
  whole_file_reads: ["GUIDE.md"],
  files: {},
  hero: null,
  ...over,
});

describe("the ModelMeasurement of 6.8", () => {
  const build = () =>
    summarize({
      model: "@cf/openai/gpt-oss-120b",
      build: "test-build",
      recordedAt: "2026-10-06T00:00:00Z",
      intents: [...ADDITIVE_INTENTS, ...HERO_INTENTS],
      results: [
        { record: rec({ intent: "A01", outcome: "completed", seconds: 2 }), rate_limited: 0, incomplete: false },
        {
          record: rec({ intent: "A02", outcome: "not_completed", stop_reason: "budget" }),
          rate_limited: 1,
          incomplete: false,
        },
        {
          record: rec({
            intent: "P1a",
            outcome: "completed",
            seconds: 4,
            hero: { class: "repaired", judged_by: "rule", before: "x", statement: "s", repair_ms: 500 },
          }),
          rate_limited: 0,
          incomplete: false,
        },
        {
          record: rec({
            intent: "P1b",
            outcome: "completed",
            seconds: 5,
            hero: { class: "not_repaired", judged_by: "rule", before: "x", statement: "s", repair_ms: 700 },
          }),
          rate_limited: 0,
          incomplete: false,
        },
      ],
      options: { reasoning_effort: "low" },
      spendUsd: 0.01,
      incomplete: false,
      energyRefs: new Map([
        ["P1a:1", true],
        ["P1b:1", true],
      ]),
    });

  it("has v 1, mode early, the agent spec, the three hashes, request and limits", () => {
    const m = build();
    expect(m.v).toBe(1);
    expect(m.mode).toBe("early");
    expect(m.agent_spec).toBe("05-agent/1");
    expect(m.prompt_hash).toBe(statedHash("prompt_hash"));
    expect(m.tools_hash).toBe(statedHash("tools_hash"));
    expect(m.texts_hash).toBe(statedHash("texts_hash"));
    expect(m.request).toEqual({
      transport: "rest",
      max_tokens: MODEL_MAX_TOKENS,
      options: { reasoning_effort: "low" },
    });
    expect(m.limits).toEqual({
      max_steps: MAX_STEPS,
      max_model_calls: MAX_MODEL_CALLS,
      attempt_timeout_ms: ATTEMPT_TIMEOUT_MS,
      model_timeout_ms: MODEL_TIMEOUT_MS,
    });
  });

  it("per-intent rows aggregate runs, landed, stops and spend", () => {
    const m = build();
    const a01 = m.intents.find((i) => i.id === "A01")!;
    expect(a01).toMatchObject({ runs: 1, landed: 1, model_calls: 3, tool_calls: 4, tokens_in: 120, tokens_out: 40 });
    const a02 = m.intents.find((i) => i.id === "A02")!;
    expect(a02.landed).toBe(0);
    expect(a02.stops).toEqual({ budget: 1 });
    // intents with no runs still appear with zeros
    const a12 = m.intents.find((i) => i.id === "A12")!;
    expect(a12.runs).toBe(0);
  });

  it("the hero block counts by ME8's 'counts as' columns", () => {
    const m = build();
    expect(m.hero.runs).toBe(2);
    expect(m.hero.references_energy_max).toBe(2); // repaired + not_repaired both count
    expect(m.hero.absolute_number).toBe(2);
    expect(m.hero.repaired_correctly).toBe(1);
    expect(m.hero.repair_ms.p50).toBe(500);
    expect(m.hero.by_intent.P1a).toMatchObject({ runs: 1, repaired_correctly: 1 });
    expect(m.hero.by_intent.P1b).toMatchObject({ runs: 1, repaired_correctly: 0 });
  });

  it("energy_creatures counts references among A08/A09/P1a/P1b landed runs", () => {
    const m = build();
    expect(m.energy_creatures).toEqual({ runs: 2, references_energy_max: 2 });
    expect(m.rate_limited).toBe(1);
    expect(m.spend_usd).toBe(0.01);
    expect(m.incomplete).toBe(false);
    expect(m.confirm).toBeNull();
    expect(m.runs).toHaveLength(4);
  });
});
