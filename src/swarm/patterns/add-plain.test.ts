import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom, h32, mulberry32 } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { ADD_PLAIN } from "./add-plain.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern: each tool call is answered by `respond`; turns stop at `wait` or `stop`. */
function run(opts: {
  rand: () => number;
  attempt_id?: string;
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
    const turn: PatternTurn = {
      last,
      heads_ups,
      hold: opts.hold ?? false,
      released: opts.released ?? false,
      state,
      attempt_id: opts.attempt_id ?? "a_test",
      rand: opts.rand,
    };
    const step = ADD_PLAIN.next(turn);
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
    case "submit":
      return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    default:
      return { result: {} };
  }
}

function repairE2(hn: number, entityKey: string): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: entityKey },
        rule: "E2",
        result: "repair",
        reason: "changed_premise",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "entity", before: "a", after: "b" },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("add-plain (02-tidepool.md 10.3)", () => {
  it("has the truth list of the pattern's row (TR8)", () => {
    expect([...ADD_PLAIN.truth]).toEqual([
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
    ]);
  });

  it("issues the canned operations of its row, in order", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "creatures/" });
    expect((calls[1] as Call).args).toEqual({ path: "GUIDE.md" });
    expect((calls[2] as Call).args).toEqual({ path: "world/bounds.js", entity: "bounce" });
    expect((calls[3] as Call).args).toEqual({ path: "world/movement.js", entity: "step" });
    expect((calls[4] as Call).args).toEqual({ path: "world/movement.js", entity: "wander" });
    // `a_test` -> `s-test`: the agent's own fresh name of 10.3.
    expect(((calls[5] as Call).args as { path: string }).path).toBe("creatures/s-test.js");
  });

  it("writes the file T-plain of 02 10.2 gives with the drawn colour and speed", () => {
    // seed 7, agent 0: mulberry32(H32("7:0")) draws 0.6111038187518716 then 0.9475811808370054,
    // so colour PALETTE[floor(0.6111*15)] = "teal" and speed SPEEDS[floor(0.9475*4)] = 2.5.
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const write = calls[5] as Call;
    expect(write.args).toEqual({
      path: "creatures/s-test.js",
      content: `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "teal";
const SPEED = 2.5;

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`,
    });
  });

  it("SW1: the same seed gives the same tool calls", () => {
    const a = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const b = run({ rand: agentRandom(7, 0), respond: seedRespond });
    expect(a.calls).toEqual(b.calls);
  });

  it("SW1: a different agent number draws a different file", () => {
    const a = run({ rand: agentRandom(7, 0), respond: seedRespond });
    const b = run({ rand: agentRandom(7, 1), respond: seedRespond });
    expect((b.calls[5] as Call).args).not.toEqual((a.calls[5] as Call).args);
  });

  it("two attempt ids write two different own names (10.3)", () => {
    // `a_first` -> `s-first`, `a_second` -> `s-second`, worked from the rule (BP1).
    const a = run({ rand: agentRandom(7, 0), attempt_id: "a_first", respond: seedRespond });
    const b = run({ rand: agentRandom(7, 0), attempt_id: "a_second", respond: seedRespond });
    expect(((a.calls[5] as Call).args as { path: string }).path).toBe("creatures/s-first.js");
    expect(((b.calls[5] as Call).args as { path: string }).path).toBe("creatures/s-second.js");
  });

  it("repair (E2) on a truth entity: reads it again, then acknowledges 'still valid'", () => {
    const inject = new Map([[6, [repairE2(1, "world/movement.js#step")]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    // After the write the heads-up arrives: the pattern re-reads the entity, then submits.
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "read", "submit"]);
    expect((calls[6] as Call).args).toEqual({ path: "world/movement.js", entity: "step" });
    expect((calls[7] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "still valid",
    });
  });

  it("SW6: a confirm heads-up is acknowledged 'not affected' with no edit", () => {
    const confirm: HeadsUp = { ...repairE2(1, "world/movement.js#step"), result: "confirm" };
    const inject = new Map([[6, [confirm]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: seedRespond, inject });
    expect(calls.map((call) => call.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect((calls[6] as Call).args).toEqual({
      summary: "add a creature",
      acknowledge: [1],
      statement: "not affected",
    });
  });

  it("SW8/SWR3: a held agent waits before submit until its pattern is released", () => {
    const calls: Call[] = [];
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    // Hold: the run must reach the submit position and then wait.
    for (let i = 0; i < 10; i += 1) {
      const step = ADD_PLAIN.next({
        last,
        heads_ups: [],
        hold: true,
        released: false,
        state,
        attempt_id: "a_test",
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
    // Released: the submit goes out.
    const released = ADD_PLAIN.next({
      last,
      heads_ups: [],
      hold: true,
      released: true,
      state,
      attempt_id: "a_test",
      rand: agentRandom(7, 0),
    });
    expect(released.kind).toBe("tool");
    if (released.kind === "tool") expect(released.tool).toBe("submit");
  });
});
