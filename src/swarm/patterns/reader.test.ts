import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { READER } from "./reader.ts";

type Call = { tool: string; args: Record<string, unknown> };

const LIST_RESULT = {
  result: {
    path: "creatures/",
    entries: [
      { name: "s0000.js", type: "file" },
      { name: "s0001.js", type: "file" },
      { name: "s0002.js", type: "file" },
      { name: "s0003.js", type: "file" },
    ],
    truncated: false,
  },
};

/** Drives the pattern; every call answered like the swarm seed. */
function run(opts: { rand?: () => number; inject?: Map<number, HeadsUp[]> }): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = READER.next({
      last,
      heads_ups,
      hold: false,
      released: false,
      state,
      attempt_id: "a_test",
      rand: opts.rand ?? agentRandom(7, 0),
    });
    state = step.state;
    if (step.kind === "tool") {
      calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
      const call = calls[calls.length - 1] as Call;
      if (call.tool === "list") last = LIST_RESULT;
      else if (call.tool === "submit")
        last = { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      else last = { result: {} };
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

/** An `info` heads-up: an F4 `holds` on the whole-file `world/energy.js` premise. */
function f4Info(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "info",
    wake: false,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "file", key: "world/energy.js" },
        rule: "F4",
        result: "holds",
        reason: "read_not_referenced",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: {
          kind: "file",
          before_oid: "a",
          after_oid: "b",
          unified: "",
          changed_entities: ["world/energy.js#ENERGY_MAX"],
        },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 0,
    head_seq: 3,
    created_at: 0,
  };
}

describe("reader (02-tidepool.md 10.3)", () => {
  it("has the truth list of the row: `bounce`, `step`, `wander`", () => {
    expect([...READER.truth]).toEqual([
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
    ]);
  });

  it("reads the whole file `world/energy.js`, then runs the `add-plain` script", () => {
    const { calls } = run({});
    expect(calls.map((call) => call.tool)).toEqual(["read", "list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "world/energy.js" });
    expect((calls[1] as Call).args).toEqual({ path: "creatures/" });
    // `a_test` -> `s-test`: the agent's own fresh name of 10.3.
    expect((calls[6] as Call).args.path).toBe("creatures/s-test.js");
  });

  it("an `info` on `world/energy.js` (F4 `holds`) gives it nothing to acknowledge", () => {
    const inject = new Map([[3, [f4Info(1)]]]);
    const { calls } = run({ inject });
    const submit = calls[calls.length - 1] as Call;
    expect(submit.tool).toBe("submit");
    expect(submit.args.acknowledge).toBeUndefined();
  });
});
