import { describe, expect, it } from "vitest";
import type { TriageInput } from "../protocol/ports.ts";
import { ScriptedTriage, scriptedAnswer } from "./scripted-triage.ts";

const TRUTH = [
  "entity:world/energy.js#ENERGY_MAX",
  "entity:world/bounds.js#bounce",
  "query:refs:world/energy.js#ENERGY_MAX",
];

function input(premises: TriageInput["premises"], truth: string[] | null): TriageInput {
  return { attempt_id: "a0", intent: "t", patch: [], premises, truth };
}

describe("scripted-triage (01-core TR8, S6a; 02-tidepool 10.1 SW5)", () => {
  it("answers 1 for a premise in the truth list and 0 for any other", () => {
    const out = ScriptedTriage.judgeNow(
      input(
        {
          q1: {
            kind: "entity",
            key: "world/energy.js#ENERGY_MAX",
            rule: "E3",
            read_then: "a",
            is_now: "b",
            changed_by_intent: null,
            changed: [],
          },
          q2: {
            kind: "entity",
            key: "world/energy.js#REST_TICKS",
            rule: "E3",
            read_then: "a",
            is_now: "b",
            changed_by_intent: null,
            changed: [],
          },
        },
        TRUTH,
      ),
    );
    expect(out.answers).toEqual({ q1: 1, q2: 0 });
    expect(out.model).toBe("scripted");
    // TR5: `judgeNow` returns the answers, never a promise: the value is not a thenable.
    expect("then" in out).toBe(false);
  });

  it("answers 1 for a file premise when an entity of D is in the truth list (TR8)", () => {
    expect(
      scriptedAnswer(TRUTH, {
        kind: "file",
        key: "world/energy.js",
        changed: ["world/energy.js#ENERGY_MAX", "world/energy.js#REST_TICKS"],
      }),
    ).toBe(1);
    expect(
      scriptedAnswer(TRUTH, {
        kind: "file",
        key: "world/energy.js",
        changed: ["world/energy.js#REST_TICKS"],
      }),
    ).toBe(0);
  });

  it("answers from `file:` and `query:` entries of the list too", () => {
    expect(scriptedAnswer(["file:creatures/d0000.js"], { kind: "file", key: "creatures/d0000.js", changed: [] })).toBe(
      1,
    );
    expect(
      scriptedAnswer(TRUTH, {
        kind: "query",
        key: "refs:world/energy.js#ENERGY_MAX",
        changed: [],
      }),
    ).toBe(1);
  });

  it("answers null (unavailable) when the attempt has no truth list", () => {
    expect(scriptedAnswer(null, { kind: "entity", key: "world/energy.js#ENERGY_MAX", changed: [] })).toBe(null);
  });
});
