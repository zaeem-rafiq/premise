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

/**
 * `respond` with ENERGY_MAX at `v`. `reads` gives the source an entity read answers, per key —
 * entries after the first are answers to re-reads. `reliedOnBy` is the referrer list the
 * `replace` on `world/energy.js` returns in `relied_on_by[ENERGY_MAX]` (D2). `fail` answers the
 * nth call with an error instead.
 */
function respondWith(
  v: number,
  extra: {
    reliedOnBy?: string[];
    reads?: Record<string, string[]>;
    fail?: Record<number, { code: string; message: string }>;
  } = {},
): (call: Call) => ModelToolMessage {
  const reads = new Map(Object.entries(extra.reads ?? {}));
  let n = 0;
  return (call) => {
    n += 1;
    const fail = extra.fail?.[n];
    if (fail !== undefined) return { error: fail };
    switch (call.tool) {
      case "read": {
        const key = `${call.args.path as string}#${call.args.entity as string}`;
        const sources = reads.get(key);
        const source =
          sources === undefined
            ? SOURCE_V100.replace("ENERGY_MAX = 100", `ENERGY_MAX = ${v}`)
            : sources.length > 1
              ? (sources.shift() as string)
              : (sources[0] ?? "");
        return { result: { key, source } };
      }
      case "replace":
        if (call.args.path === "world/energy.js") {
          return { result: { relied_on_by: { "world/energy.js#ENERGY_MAX": extra.reliedOnBy ?? [] } } };
        }
        return { result: {} };
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
function repairQR1(hn: number, module = "creatures/s0004.js"): HeadsUp {
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
              key: `${module}#(import ../world/energy.js)`,
              source: 'import { ENERGY_MAX } from "../world/energy.js";',
            },
            { key: `${module}#spawn`, source: "export function spawn() { ... }" },
          ],
          removed: [],
          context: [
            { key: `${module}#update`, source: T_ENERGY_UPDATE },
            { key: `${module}#draw`, source: "export function draw(creature, pen) { ... }" },
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

  it("D2/SW2: a named referrer's absolute threshold is read, then replaced with 0.3 x new V", () => {
    const reliedOnBy = [
      "creatures/s0004.js#(import ../world/energy.js)",
      "creatures/s0004.js#spawn",
      "creatures/s0004.js#update",
      "world/energy.js#liveOneTick",
      "world/rules.js#(import ./energy.js)",
    ];
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy,
        reads: { "creatures/s0004.js#update": [T_ENERGY_UPDATE] },
      }),
    });
    // One `update` read for the one creature module; the world/* referrers are left alone.
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "replace", "submit"]);
    expect((calls[2] as Call).args).toEqual({ path: "creatures/s0004.js", entity: "update" });
    expect((calls[3] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: "creature.energy < 30",
      new: "creature.energy < 0.3",
    });
  });

  it("D2/SW2: every named referrer module is repaired once", () => {
    const reliedOnBy = [
      "creatures/s0004.js#(import ../world/energy.js)",
      "creatures/s0004.js#spawn",
      "creatures/s0005.js#(import ../world/energy.js)",
      "creatures/s0005.js#spawn",
      "creatures/s0005.js#update",
    ];
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy,
        reads: {
          "creatures/s0004.js#update": [T_ENERGY_UPDATE],
          "creatures/s0005.js#update": [T_ENERGY_UPDATE],
        },
      }),
    });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "replace", "read", "replace", "submit"]);
    const reads = calls.filter((call) => call.tool === "read").map((call) => call.args.path);
    expect(reads).toEqual(["world/energy.js", "creatures/s0004.js", "creatures/s0005.js"]);
    expect((calls[5] as Call).args).toEqual({
      path: "creatures/s0005.js",
      old: "creature.energy < 30",
      new: "creature.energy < 0.3",
    });
  });

  it("D2/SW2: a referrer the relied_on_by list does not name is never visited", () => {
    const reliedOnBy = ["world/energy.js#liveOneTick", "world/rules.js#(import ./energy.js)"];
    const { calls } = run({ rand: agentRandom(7, 0), respond: respondWith(100, { reliedOnBy }) });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "submit"]);
  });

  it("D2: a T-relative referrer is left alone", () => {
    const relative = T_ENERGY_UPDATE.replace("creature.energy < 30", "creature.energy < ENERGY_MAX * 0.3");
    const reliedOnBy = ["creatures/s0006.js#update", "creatures/s0006.js#spawn"];
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy,
        reads: { "creatures/s0006.js#update": [relative] },
      }),
    });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "submit"]);
    expect(calls.some((call) => call.tool === "replace" && call.args.path === "creatures/s0006.js")).toBe(false);
  });

  it("D2/SW2: the reverse rescale repairs a stranded 0.3 back to 30", () => {
    const stranded = T_ENERGY_UPDATE.replace("creature.energy < 30", "creature.energy < 0.3");
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(1, {
        reliedOnBy: ["creatures/s0004.js#spawn"],
        reads: { "creatures/s0004.js#update": [stranded] },
      }),
    });
    expect((calls[1] as Call).args).toEqual({
      path: "world/energy.js",
      old: "ENERGY_MAX = 1",
      new: "ENERGY_MAX = 100",
    });
    expect((calls[3] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: "creature.energy < 0.3",
      new: "creature.energy < 30",
    });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "replace", "submit"]);
  });

  it("D2/QR1: a referrer named by relied_on_by and again by a QR1 is repaired once", () => {
    const inject = new Map([[3, [repairQR1(1)]]]);
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy: ["creatures/s0004.js#spawn"],
        reads: { "creatures/s0004.js#update": [T_ENERGY_UPDATE] },
      }),
      inject,
    });
    const repairs = calls.filter((call) => call.tool === "replace" && call.args.path === "creatures/s0004.js");
    expect(repairs).toHaveLength(1);
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "replace", "submit"]);
    // The heads-up queued nothing the `relied_on_by` visit had not already queued.
    expect((calls[4] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "not affected",
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

  it("OP1: a dropped referrer repair re-reads the module and rewrites the new threshold", () => {
    // Another change landed first: `creature.energy < 30` no longer matches; the file now holds
    // `creature.energy < 42`. The repair is applied again on the current source (SW6).
    const shifted = T_ENERGY_UPDATE.replace("creature.energy < 30", "creature.energy < 42");
    const dropped: HeadsUp = {
      ...repairQR1(1),
      items: [],
      dropped_ops: [{ op_seq: 2, path: "creatures/s0004.js", rule: "OP1" }],
    };
    const inject = new Map([[4, [dropped]]]);
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy: ["creatures/s0004.js#spawn"],
        reads: { "creatures/s0004.js#update": [T_ENERGY_UPDATE, shifted] },
      }),
      inject,
    });
    expect(calls.map((call) => call.tool)).toEqual(["read", "replace", "read", "replace", "read", "replace", "submit"]);
    expect((calls[4] as Call).args).toEqual({ path: "creatures/s0004.js", entity: "update" });
    expect((calls[5] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: "creature.energy < 42",
      new: "creature.energy < 0.3",
    });
    expect((calls[6] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "reapplied the edit",
    });
  });

  it("TA3: a repair refused `heads_up_first` is decided again, then the visits resume", () => {
    const inject = new Map([[4, [repairQR1(1, "creatures/s0006.js")]]]);
    const { calls } = run({
      rand: agentRandom(7, 0),
      respond: respondWith(100, {
        reliedOnBy: ["creatures/s0004.js#spawn", "creatures/s0005.js#spawn"],
        reads: {
          "creatures/s0004.js#update": [T_ENERGY_UPDATE],
          "creatures/s0005.js#update": [T_ENERGY_UPDATE],
        },
        fail: { 4: { code: "heads_up_first", message: "unresolved heads-up 1 not shown" } },
      }),
      inject,
    });
    expect(calls.map((call) => call.tool)).toEqual([
      "read",
      "replace",
      "read",
      "replace",
      "replace",
      "replace",
      "read",
      "replace",
      "submit",
    ]);
    // Call 4 was refused without being recorded (TA3); the queue's head is issued again.
    expect((calls[3] as Call).args).toEqual((calls[4] as Call).args);
    expect((calls[5] as Call).args).toEqual({
      path: "creatures/s0006.js",
      old: "creature.energy < 30",
      new: "creature.energy < 0.3",
    });
    expect((calls[8] as Call).args).toEqual({
      summary: "rescale ENERGY_MAX",
      acknowledge: [1],
      statement: "rescaled the threshold",
    });
  });
});
