import { describe, expect, it } from "vitest";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { Pattern, PatternTurn } from "../pattern.ts";
import { EDIT_CREATURE } from "./edit-creature.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern; each call answered by `respond`; turns stop at `wait` or `stop`. */
function run(
  pattern: Pattern,
  opts: { rand: () => number; respond: (call: Call) => ModelToolMessage },
): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const turn: PatternTurn = {
      last,
      heads_ups: [],
      hold: false,
      released: false,
      state,
      attempt_id: "a_test",
      rand: opts.rand,
    };
    const step = pattern.next(turn);
    state = step.state;
    if (step.kind === "tool") {
      calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
      last = opts.respond(calls[calls.length - 1] as Call);
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

const SPEED_SOURCE = `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "teal";
const SPEED = 1;
`;

describe("edit-creature (02-tidepool.md 10.3)", () => {
  it("draws one of s0000 to s0003 and steps `const SPEED = <a>;` around the cycle", () => {
    // seed 7, agent 5 draws 0.1655 -> floor(0.1655*4) = 0 -> `s0000`: SPEED 1 -> 1.5.
    const { calls } = run(EDIT_CREATURE, {
      rand: agentRandom(7, 5),
      respond: (call) => {
        if (call.tool === "read") return { result: { source: SPEED_SOURCE } };
        if (call.tool === "submit")
          return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
        return { result: {} };
      },
    });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "creatures/s0000.js", entity: "SPEED" });
    expect((calls[1] as Call).args).toEqual({
      path: "creatures/s0000.js",
      old: "const SPEED = 1;",
      new: "const SPEED = 1.5;",
    });
  });

  it("truthOf names the drawn creature's SPEED entity (the row's `entity:creatures/s000<k>.js#SPEED`)", () => {
    expect(EDIT_CREATURE.truthOf?.(agentRandom(7, 5))).toEqual(["entity:creatures/s0000.js#SPEED"]);
    // agent 0 draws 0.6111 -> pick 2 -> s0002.
    expect(EDIT_CREATURE.truthOf?.(agentRandom(7, 0))).toEqual(["entity:creatures/s0002.js#SPEED"]);
  });

  it("steps the whole cycle: 2.5 wraps back to 1", () => {
    let first = true;
    const rand = () => {
      if (first) {
        first = false;
        return 0.01;
      } // pick 0 -> s0000
      return 0.5;
    };
    const { calls } = run(EDIT_CREATURE, {
      rand,
      respond: (call) => {
        if (call.tool === "read") return { result: { source: SPEED_SOURCE.replace("SPEED = 1;", "SPEED = 2.5;") } };
        if (call.tool === "submit")
          return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
        return { result: {} };
      },
    });
    expect((calls[1] as Call).args).toEqual({
      path: "creatures/s0000.js",
      old: "const SPEED = 2.5;",
      new: "const SPEED = 1;",
    });
  });
});
