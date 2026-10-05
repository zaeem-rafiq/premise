import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { Pattern, PatternTurn } from "../pattern.ts";
import { RETUNE } from "./retune.ts";

type Call = { tool: string; args: Record<string, unknown> };

/** Drives the pattern: each tool call is answered by `respond`; turns stop at `wait` or `stop`. */
function run(
  pattern: Pattern,
  opts: {
    rand: () => number;
    hold?: boolean;
    released?: boolean;
    respond: (call: Call) => ModelToolMessage;
    inject?: Map<number, HeadsUp[]>;
  },
): { calls: Call[]; outcome: string } {
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

/** The REST_TICKS entity source answers, standing in for the seed's `world/energy.js`. */
function respond(source: string): (call: Call) => ModelToolMessage {
  return (call) => {
    if (call.tool === "read") return { result: { source } };
    if (call.tool === "submit") return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    return { result: {} };
  };
}

/** A `repair` heads-up whose dropped op is the recorded `replace` (E1 + OP1 of the row). */
function repairE1(hn: number, entityKey: string): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: entityKey },
        rule: "E1",
        result: "repair",
        reason: "edited_entity_changed",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "entity", before: "a", after: "b" },
        uses: [],
      },
    ],
    dropped_ops: [{ op_seq: 1, path: "world/energy.js", rule: "OP1" }],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("retune (02-tidepool.md 10.3)", () => {
  it("draws its constant from the stream and steps the cycle once", () => {
    // seed 7, agent 0 draws 0.6111 -> floor(0.6111*4) = 2 -> `energy#REST_TICKS` (300 -> 240).
    const { calls } = run(RETUNE, { rand: agentRandom(7, 0), respond: respond("export const REST_TICKS = 300;") });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "world/energy.js", entity: "REST_TICKS" });
    expect((calls[1] as Call).args).toEqual({
      path: "world/energy.js",
      old: "export const REST_TICKS = 300;",
      new: "export const REST_TICKS = 240;",
    });
  });

  it("truthOf names the drawn entity, `entity:<path>#<name>` (the row)", () => {
    // The same stream position the pattern's first draw consumes names the same target.
    expect(RETUNE.truthOf?.(agentRandom(7, 0))).toEqual(["entity:world/energy.js#REST_TICKS"]);
    // agent 5 draws 0.1655 -> pick 0 -> `movement#MAX_SPEED`.
    expect(RETUNE.truthOf?.(agentRandom(7, 5))).toEqual(["entity:world/movement.js#MAX_SPEED"]);
  });

  it("cycles each of the row's four constants when drawn", () => {
    // By stream: n=0 -> REST_TICKS, n=1 (0.4827 -> pick 1) -> FOOD_EVERY,
    // n=4 (0.8742 -> pick 3) -> DAY_TICKS, and pick 0 -> MAX_SPEED.
    const picks: Record<number, { entity: string; old: string; new: string }> = {
      0: { entity: "MAX_SPEED", old: "export const MAX_SPEED = 3;", new: "export const MAX_SPEED = 3.5;" },
      1: { entity: "FOOD_EVERY", old: "export const FOOD_EVERY = 30;", new: "export const FOOD_EVERY = 20;" },
      2: { entity: "REST_TICKS", old: "export const REST_TICKS = 300;", new: "export const REST_TICKS = 240;" },
      3: { entity: "DAY_TICKS", old: "const DAY_TICKS = 3600;", new: "const DAY_TICKS = 2400;" },
    };
    const drawFor = (pick: number) => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return pick / 4 + 0.01;
        }
        return 0.5;
      };
    };
    for (const [pick, want] of Object.entries(picks)) {
      const path = ["world/movement.js", "world/food.js", "world/energy.js", "world/time.js"][Number(pick)];
      const { calls } = run(RETUNE, {
        rand: drawFor(Number(pick)),
        respond: respond(want.old),
      });
      expect((calls[0] as Call).args).toEqual({ path, entity: want.entity });
      expect((calls[1] as Call).args).toEqual({ path, old: want.old, new: want.new });
    }
  });

  it("repair (E1, with OP1): reads the entity again, replaces from the new current value, acknowledges", () => {
    // The partner's retune landed 300 -> 240 under the recorded replace: the re-read shows 240
    // and the repair replace writes the cycle's next, 360.
    const inject = new Map([[2, [repairE1(1, "world/energy.js#REST_TICKS")]]]);
    let reads = 0;
    const { calls } = run(RETUNE, {
      rand: agentRandom(7, 0),
      inject,
      respond: (call) => {
        // The partner's retune landed 300 -> 240 under the recorded replace: the re-read
        // shows the new current value 240, and the repair replace writes the next, 360.
        if (call.tool === "read")
          return {
            result: {
              source: (reads += 1) === 1 ? "export const REST_TICKS = 300;" : "export const REST_TICKS = 240;",
            },
          };
        if (call.tool === "submit")
          return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
        return { result: {} };
      },
    });
    // After the replace's answer the heads-up arrives: re-read, replace from the new current.
    const tools = calls.map((call) => call.tool);
    expect(tools).toEqual(["read", "replace", "read", "replace", "submit"]);
    expect((calls[3] as Call).args).toEqual({
      path: "world/energy.js",
      old: "export const REST_TICKS = 240;",
      new: "export const REST_TICKS = 360;",
    });
    expect((calls[4] as Call).args).toEqual({
      summary: "retune a world constant",
      acknowledge: [1],
      statement: "retuned from the new value",
    });
  });

  it("SW6: a `no_match` on the replace ends the attempt `withdrawn`", () => {
    const { outcome } = run(RETUNE, {
      rand: agentRandom(7, 0),
      respond: (call) => {
        if (call.tool === "read") return { result: { source: "export const REST_TICKS = 300;" } };
        if (call.tool === "replace") return { error: { code: "no_match", message: "x" } };
        return { result: {} };
      },
    });
    expect(outcome).toBe("stop");
  });

  it("SW8/SWR3: a held agent waits before submit until released", () => {
    const calls: Call[] = [];
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    const rand = agentRandom(7, 0);
    for (let i = 0; i < 10; i += 1) {
      const step = RETUNE.next({ last, heads_ups: [], hold: true, released: false, state, rand });
      state = step.state;
      if (step.kind === "wait") break;
      if (step.kind === "tool") {
        calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
        last = respond("export const REST_TICKS = 300;")(calls[calls.length - 1] as Call);
      }
    }
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace"]);
    const step = RETUNE.next({ last, heads_ups: [], hold: true, released: true, state, rand });
    expect(step.kind).toBe("tool");
    expect((step as { tool?: string }).tool).toBe("submit");
  });
});
