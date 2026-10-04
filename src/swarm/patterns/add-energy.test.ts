import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { ADD_ENERGY } from "./add-energy.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern: each tool call is answered by `respond`; turns stop at `wait` or `stop`. */
function run(opts: {
  rand: () => number;
  hold?: boolean;
  released?: boolean;
  respond: (call: Call) => ModelToolMessage;
  inject?: Map<number, HeadsUp[]>;
}): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = ADD_ENERGY.next({
      last,
      heads_ups,
      hold: opts.hold ?? false,
      released: opts.released ?? false,
      state,
      rand: opts.rand,
    } as PatternTurn);
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

const ENERGY_SOURCE_V100 = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;

const ENERGY_SOURCE_V1 = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;`;

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
        return { result: { key: "world/energy.js#ENERGY_MAX", source: ENERGY_SOURCE_V100 } };
      }
      return { result: {} };
    case "submit":
      return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    default:
      return { result: {} };
  }
}

function headsUp(hn: number, opts: { result: string; rule: string; after?: string; dropped?: boolean }): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: opts.result as HeadsUp["result"],
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: opts.rule,
        result: opts.result === "repair" ? "repair" : "holds",
        reason: "changed_premise",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "entity", before: ENERGY_SOURCE_V100, after: opts.after ?? ENERGY_SOURCE_V1 },
        uses: [],
      },
    ],
    dropped_ops: opts.dropped ? [{ op_seq: 1, path: "creatures/s0004.js", rule: "OP5" }] : [],
    go_around: opts.result === "repair" ? 1 : null,
    head_seq: 3,
    created_at: 0,
  };
}

describe("add-energy (02-tidepool.md 10.3)", () => {
  it("has the truth list of the pattern's row (TR8)", () => {
    expect([...ADD_ENERGY.truth]).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
    ]);
  });

  it("issues the canned operations of its row, in order", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "creatures/" });
    expect((calls[1] as Call).args).toEqual({ path: "GUIDE.md" });
    expect((calls[2] as Call).args).toEqual({ path: "world/bounds.js", entity: "bounce" });
    expect((calls[3] as Call).args).toEqual({ path: "world/movement.js", entity: "step" });
    expect((calls[4] as Call).args).toEqual({ path: "world/energy.js", entity: "ENERGY_MAX" });
    expect(((calls[5] as Call).args as { path: string }).path).toBe("creatures/s0004.js");
  });

  it("writes T-energy with the threshold 0.3 x V parsed from the ENERGY_MAX it read", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const content = ((calls[5] as Call).args as { content: string }).content;
    expect(content).toContain("creature.energy < 30");
    expect(content).toContain('import { ENERGY_MAX } from "../world/energy.js";');
  });

  it("SW1: the same seed gives the same tool calls", () => {
    const a = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const b = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(a.calls).toEqual(b.calls);
  });

  it("repair (E2) on ENERGY_MAX: replaces the threshold with 0.3 x new V, acknowledges", () => {
    const inject = new Map([[6, [headsUp(1, { result: "repair", rule: "E2" })]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    expect(calls.map((call) => call.tool)).toEqual([
      "list",
      "read",
      "read",
      "read",
      "read",
      "write",
      "replace",
      "submit",
    ]);
    expect((calls[6] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: "creature.energy < 30",
      new: "creature.energy < 0.3",
    });
    expect((calls[7] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "rescaled the threshold",
    });
  });

  it("info (X0) on ENERGY_MAX before its write: the write uses the new V", () => {
    const inject = new Map([[5, [headsUp(1, { result: "info", rule: "X0" })]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    const content = ((calls[5] as Call).args as { content: string }).content;
    expect(content).toContain("creature.energy < 0.3");
    // An info heads-up is not acknowledged: the submit carries no acknowledge list.
    expect((calls[6] as Call).args).toEqual({ summary: "add a creature" });
  });

  it("SW6: a confirm heads-up is acknowledged 'not affected' with no edit", () => {
    const inject = new Map([[6, [headsUp(1, { result: "confirm", rule: "E2m" })]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[6] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "not affected",
    });
  });

  it("SW6: a dropped write is applied again, then acknowledged", () => {
    const inject = new Map([[6, [headsUp(1, { result: "repair", rule: "F1", dropped: true })]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    expect(calls.map((call) => call.tool)).toEqual([
      "list",
      "read",
      "read",
      "read",
      "read",
      "write",
      "write",
      "submit",
    ]);
    expect((calls[6] as Call).tool).toBe("write");
    expect(((calls[6] as Call).args as { path: string }).path).toBe("creatures/s0004.js");
    expect((calls[7] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "reapplied the edit",
    });
  });

  it("SW8/SWR3: a held agent waits before submit until released", () => {
    const calls: Call[] = [];
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    for (let i = 0; i < 10; i += 1) {
      const step = ADD_ENERGY.next({
        last,
        heads_ups: [],
        hold: true,
        released: false,
        state,
        rand: agentRandom(7, 0),
      });
      state = step.state;
      if (step.kind === "wait") break;
      if (step.kind === "tool") {
        calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
        last = seedRespond(calls[calls.length - 1] as Call);
      }
    }
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write"]);
    const released = ADD_ENERGY.next({
      last,
      heads_ups: [],
      hold: true,
      released: true,
      state,
      rand: agentRandom(7, 0),
    });
    expect(released.kind).toBe("tool");
    if (released.kind === "tool") expect(released.tool).toBe("submit");
  });

  it("SW6: an error the script cannot fix ends the attempt with `stop` `withdrawn`", () => {
    const inject = new Map([[6, [headsUp(1, { result: "repair", rule: "E2" })]]]);
    const { calls, outcome } = run({
      rand: agentRandom(7, 0),
      inject,
      respond: (call) => {
        if (call.tool === "replace") return { error: { code: "no_match", message: "gone" } };
        return seedRespond(call);
      },
    });
    expect(outcome).toBe("stop");
    expect(calls.map((call) => call.tool)).toContain("replace");
  });
});
