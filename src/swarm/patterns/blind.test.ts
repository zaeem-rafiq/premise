import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { BLIND } from "./blind.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern; `submit` answers `needs_confirm` once (B1) then validates. */
function run(opts: { rand: () => number; inject?: Map<number, HeadsUp[]> }): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  let submitted = 0;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = BLIND.next({
      last,
      heads_ups,
      hold: false,
      released: false,
      state,
      attempt_id: "a_test",
      rand: opts.rand,
    });
    state = step.state;
    if (step.kind === "tool") {
      calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
      const call = calls[calls.length - 1] as Call;
      if (call.tool === "submit")
        last =
          (submitted += 1) === 1
            ? { result: { status: "needs_confirm", submit_id: "s_1", tier: "auto", checks: [] } }
            : { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      else last = { result: {} };
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

describe("blind (02-tidepool.md 10.3)", () => {
  it("has the truth list of the row: `bounce`, `step`, `wander`", () => {
    expect([...BLIND.truth]).toEqual([
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
    ]);
  });

  it("reads GUIDE.md, writes T-plain to its own fresh name, and answers B1's `confirm` with an acknowledged resubmit", () => {
    const { calls } = run({ rand: agentRandom(7, 0) });
    expect(calls.map((call) => call.tool)).toEqual(["read", "write", "submit", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "GUIDE.md" });
    // `a_test` -> `s-test`: the agent's own fresh name of 10.3.
    expect((calls[1] as Call).args.path).toBe("creatures/s-test.js");
    const content = (calls[1] as Call).args.content as string;
    expect(content).toContain("wander(creature, 0.05)");
  });

  it("SW1: the same seed draws the same file", () => {
    const a = run({ rand: agentRandom(7, 0) });
    const b = run({ rand: agentRandom(7, 0) });
    expect(a.calls).toEqual(b.calls);
  });
});
