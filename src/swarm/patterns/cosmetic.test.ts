import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import { COSMETIC } from "./cosmetic.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern: each tool call is answered by `respond`; turns stop at `wait` or `stop`. */
function run(opts: {
  rand: () => number;
  respond: (call: Call) => ModelToolMessage;
  inject?: Map<number, HeadsUp[]>;
}): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = COSMETIC.next({
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
      last = opts.respond(calls[calls.length - 1] as Call);
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

function seedRespond(call: Call): ModelToolMessage {
  switch (call.tool) {
    case "submit":
      return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    default:
      return { result: {} };
  }
}

function confirmE2m(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "confirm",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: "E2m",
        result: "confirm",
        reason: "module_reference_changed",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "entity", before: "a", after: "b" },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: null,
    head_seq: 3,
    created_at: 0,
  };
}

function repairDropped(hn: number): HeadsUp {
  return {
    ...confirmE2m(hn),
    result: "repair",
    items: [],
    dropped_ops: [{ op_seq: 1, path: "world/energy.js", rule: "OP1" }],
    go_around: 1,
  };
}

describe("cosmetic (02-tidepool.md 10.3)", () => {
  it("has the empty truth list of the pattern's row (TR8)", () => {
    expect([...COSMETIC.truth]).toEqual([]);
  });

  it("issues the canned operations of its row, in order", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "world/energy.js" });
    const args = (calls[1] as Call).args as { path: string; old: string; new: string };
    expect(args.path).toBe("world/energy.js");
    expect(args.old.startsWith("// ")).toBe(true);
    expect(args.old === args.new).toBe(false);
  });

  it("SW1: the same seed draws the same rewording; different agents may draw different ones", () => {
    const a = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const b = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(a.calls).toEqual(b.calls);
  });

  it("SW6: the E2m confirm of its row is acknowledged 'not affected' with no edit", () => {
    const inject = new Map([[2, [confirmE2m(1)]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[2] as Call).args).toEqual({
      summary: "reword a comment",
      acknowledge: [1],
      statement: "not affected",
    });
  });

  it("OP1 on the same line: the reapply answers no_match -> `stop` `withdrawn`", () => {
    const inject = new Map([[2, [repairDropped(1)]]]);
    let replaces = 0;
    const { calls, outcome } = run({
      rand: agentRandom(7, 0),
      inject,
      respond: (call) => {
        if (call.tool !== "replace") return seedRespond(call);
        replaces += 1;
        // The first `replace` lands; the reapply finds its `old` text gone (OP1 replay).
        return replaces === 1 ? { result: {} } : { error: { code: "no_match", message: "gone" } };
      },
    });
    expect(outcome).toBe("stop");
    // The dropped operation is applied once more on the current source before it gives up (SW6).
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "replace"]);
  });
});
