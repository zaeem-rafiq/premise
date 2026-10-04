import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import { ADD_RELATIVE } from "./add-relative.ts";

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
    const step = ADD_RELATIVE.next({
      last,
      heads_ups,
      hold: false,
      released: false,
      state,
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

/** Canned answers from the tidepool-swarm seed (s0000.js to s0003.js already exist). */
function seedRespond(call: Call): ModelToolMessage {
  switch (call.tool) {
    case "list":
      return {
        result: {
          path: "creatures/",
          entries: [
            { name: "s0000.js", type: "file" },
            { name: "s0001.js", type: "file" },
            { name: "s0002.js", type: "file" },
            { name: "s0003.js", type: "file" },
            { name: "fish.js", type: "file" },
          ],
          truncated: false,
        },
      };
    case "read":
      if ((call.args as { entity?: string }).entity === "ENERGY_MAX") {
        return {
          result: {
            key: "world/energy.js#ENERGY_MAX",
            source: `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`,
          },
        };
      }
      return { result: {} };
    case "submit":
      return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    default:
      return { result: {} };
  }
}

/** The `E2` repair on `ENERGY_MAX` a rescale landing gives an in-flight `add-relative`. */
function repairE2(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: "E2",
        result: "repair",
        reason: "changed_premise",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: {
          kind: "entity",
          before: "export const ENERGY_MAX = 100;",
          after: "export const ENERGY_MAX = 1;",
        },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("add-relative (02-tidepool.md 10.3)", () => {
  it("has the truth list of the pattern's row (TR8): `bounce`, `step`, not `ENERGY_MAX`", () => {
    expect([...ADD_RELATIVE.truth]).toEqual(["entity:world/bounds.js#bounce", "entity:world/movement.js#step"]);
  });

  it("issues the same calls as `add-energy`, in order", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[4] as Call).args).toEqual({ path: "world/energy.js", entity: "ENERGY_MAX" });
    expect(((calls[5] as Call).args as { path: string }).path).toBe("creatures/s0004.js");
  });

  it("writes T-relative: the threshold text `ENERGY_MAX * 0.3`, not a number", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const content = ((calls[5] as Call).args as { content: string }).content;
    expect(content).toContain("creature.energy < ENERGY_MAX * 0.3");
    expect(content).toContain('import { ENERGY_MAX } from "../world/energy.js";');
  });

  it("repair (E2) on ENERGY_MAX: acknowledges with no edit (the designed false abort)", () => {
    const inject = new Map([[6, [repairE2(1)]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    // No `replace` call is made: the acknowledging submit carries `changed: false` (HU12).
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[6] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "not affected",
    });
  });
});
