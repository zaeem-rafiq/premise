import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import { RESCALE_ENERGY } from "./rescale-energy.ts";

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
    const step = RESCALE_ENERGY.next({
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

const SOURCE_V100 = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;

/** `respond` with ENERGY_MAX at `v`. */
function respondWith(v: number): (call: Call) => ModelToolMessage {
  return (call) => {
    switch (call.tool) {
      case "read":
        return {
          result: {
            key: "world/energy.js#ENERGY_MAX",
            source: SOURCE_V100.replace("ENERGY_MAX = 100", `ENERGY_MAX = ${v}`),
          },
        };
      case "submit":
        return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      default:
        return { result: {} };
    }
  };
}

const T_ENERGY_UPDATE = `export function update(creature) {
  if (creature.energy < 30) return;
  step(creature);
  bounce(creature);
}`;

/** The QR1 repair an `add-energy` landing gives an in-flight `rescale-energy`. */
function repairQR1(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "query", key: "refs:world/energy.js#ENERGY_MAX" },
        rule: "QR1",
        result: "repair",
        reason: "new_reference_to_altered_entity",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: {
          kind: "query",
          added: [
            {
              key: "creatures/s0004.js#(import ../world/energy.js)",
              source: 'import { ENERGY_MAX } from "../world/energy.js";',
            },
            { key: "creatures/s0004.js#spawn", source: "export function spawn() { ... }" },
          ],
          removed: [],
          context: [
            { key: "creatures/s0004.js#update", source: T_ENERGY_UPDATE },
            { key: "creatures/s0004.js#draw", source: "export function draw(creature, pen) { ... }" },
          ],
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

/** The E1 repair a first rescale's landing gives the second one. */
function repairE1(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: "E1",
        result: "repair",
        reason: "edited_entity_changed",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "entity", before: SOURCE_V100, after: "export const ENERGY_MAX = 1;" },
        uses: [],
      },
    ],
    dropped_ops: [{ op_seq: 1, path: "world/energy.js", rule: "OP1" }],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("rescale-energy (02-tidepool.md 10.3)", () => {
  it("has the truth list of the pattern's row (TR8)", () => {
    expect([...RESCALE_ENERGY.truth]).toEqual([
      "entity:world/energy.js#ENERGY_MAX",
      "query:refs:world/energy.js#ENERGY_MAX",
    ]);
  });

  it("issues the canned operations of its row, in order", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(100) });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[0] as Call).args).toEqual({ path: "world/energy.js", entity: "ENERGY_MAX" });
    expect((calls[1] as Call).args).toEqual({
      path: "world/energy.js",
      old: "ENERGY_MAX = 100",
      new: "ENERGY_MAX = 1",
    });
    expect((calls[2] as Call).args).toEqual({ summary: "rescale ENERGY_MAX" });
  });

  it("or the reverse: ENERGY_MAX = 1 becomes ENERGY_MAX = 100", () => {
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(1) });
    expect((calls[1] as Call).args).toEqual({
      path: "world/energy.js",
      old: "ENERGY_MAX = 1",
      new: "ENERGY_MAX = 100",
    });
  });

  it("repair (QR1): replaces the T-energy threshold of the gained module, then acknowledges", () => {
    const inject = new Map([[2, [repairQR1(1)]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(100), inject });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "replace", "submit"]);
    // The gained module's `update` holds `creature.energy < 30`; new V is 1, so 0.3 x 1 = 0.3.
    expect((calls[2] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: "creature.energy < 30",
      new: "creature.energy < 0.3",
    });
    expect((calls[3] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "rescaled the threshold",
    });
  });

  it("repair (QR1): a T-relative gained module needs no replace but is still acknowledged", () => {
    const relative = repairQR1(1);
    const item = relative.items[0]!;
    if (item.diff.kind === "query") {
      item.diff.context = [
        {
          key: "creatures/s0004.js#update",
          source: T_ENERGY_UPDATE.replace("creature.energy < 30", "creature.energy < ENERGY_MAX * 0.3"),
        },
      ];
    }
    const inject = new Map([[2, [relative]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(100), inject });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
    expect((calls[2] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "not affected",
    });
  });

  it("repair (E1, with OP1): another rescale landed first -> `stop` `withdrawn` (TA9a)", () => {
    const inject = new Map([[2, [repairE1(1)]]]);
    const { calls, outcome } = run({ rand: agentRandom(7, 0), respond: respondWith(100), inject });
    expect(outcome).toBe("stop");
    // It never submits and never acknowledges: `stop` ends the attempt.
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace"]);
  });

  it("SW6: a dropped operation is applied again, then acknowledged", () => {
    const dropped: HeadsUp = {
      ...repairQR1(1),
      items: [],
      dropped_ops: [{ op_seq: 1, path: "world/energy.js", rule: "OP3" }],
    };
    const inject = new Map([[2, [dropped]]]);
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(100), inject });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "replace", "submit"]);
    expect((calls[2] as Call).args).toEqual({
      path: "world/energy.js",
      old: "ENERGY_MAX = 100",
      new: "ENERGY_MAX = 1",
    });
    expect((calls[3] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "reapplied the edit",
    });
  });
});
