// ClefRisk (01-core 10.4, RK1, RK3) against a fake `AI` binding: the three questions in 10.4's
// words, the answers read from `answers.<id>.noul`, and an unavailable answer as a code.

import { describe, expect, it } from "vitest";
import type { RiskInput } from "../../../protocol/ports.ts";
import { ClefRisk } from "./clef-risk.ts";

const INPUT: RiskInput = {
  intent: "make energy a fraction from 0 to 1",
  summary: "Change ENERGY_MAX from 100 to 1",
  held_paths: ["world/**", "main.js", "pen.js", "index.html", "selftest/**", "GUIDE.md"],
  files: [
    {
      path: "world/energy.js",
      tier: "held",
      entities: [
        {
          key: "world/energy.js#ENERGY_MAX",
          before: "export const ENERGY_MAX = 100;",
          after: "export const ENERGY_MAX = 1;",
        },
      ],
    },
  ],
};

function risk(answer: () => unknown) {
  const calls: Array<{ model: string; request: Record<string, unknown> }> = [];
  const judge = new ClefRisk(
    {
      ai: {
        async run(model, request) {
          calls.push({ model, request });
          return answer();
        },
      },
      gate: {
        reserve: async () => ({ ok: true, reservation_id: "r1", expires_at: 0 }),
        settle: async () => ({ ok: true, charged_usd: 0, found: true }),
      },
      pool: "p",
      modelId: "@cf/cloudflare/clef",
      model: "clef",
    },
    "a_rescale",
  );
  return { calls, judge };
}

describe("ClefRisk (10.4)", () => {
  it("10.4: asks the three questions about the submit's state, in 10.4's words", async () => {
    const f = risk(() => ({
      answers: {
        does_what_asked: { noul: 0.9 },
        changes_shared_meaning: { noul: 0.8 },
        unrelated_edits: { noul: 0.1 },
      },
    }));
    await f.judge.judge(INPUT);
    expect(f.calls[0]?.model).toBe("@cf/cloudflare/clef");
    expect(f.calls[0]?.request).toEqual({
      model: "clef",
      state: INPUT,
      questions: {
        does_what_asked: { type: "noul", instructions: "Do the changes in `files` do what `intent` asks for?" },
        changes_shared_meaning: {
          type: "noul",
          instructions:
            "Do the changes in `files` change the meaning of existing code under `held_paths` that other code may " +
            "rely on (a value, unit, range, signature or behaviour), as opposed to only adding new things?",
        },
        unrelated_edits: {
          type: "noul",
          instructions: "Do the changes in `files` include edits that `intent` did not ask for?",
        },
      },
    });
  });

  it("RK1: the answers are read from answers.<id>.noul", async () => {
    const f = risk(() => ({
      model: "clef",
      answers: {
        does_what_asked: { noul: 0.9 },
        changes_shared_meaning: { noul: 0.8 },
        unrelated_edits: { noul: 0.1 },
      },
    }));
    expect(await f.judge.judge(INPUT)).toEqual({
      model: "clef",
      does_what_asked: 0.9,
      changes_shared_meaning: 0.8,
      unrelated_edits: 0.1,
    });
  });

  it("RK3: an unavailable answer carries an error code", async () => {
    const f = risk(() => ({ answers: {} }));
    expect(await f.judge.judge(INPUT)).toEqual({
      model: "clef",
      does_what_asked: null,
      changes_shared_meaning: null,
      unrelated_edits: null,
      error: "malformed",
    });
  });
});
