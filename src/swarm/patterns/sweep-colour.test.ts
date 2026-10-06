import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { SWEEP_COLOUR } from "./sweep-colour.ts";

type Call = { tool: string; args: Record<string, unknown> };

const CREATURE_A = `const ARMS = "pink";\nexport function spawn() { return {}; }\n`;
const CREATURE_B = `const BODY = "orange";\nexport function spawn() { return {}; }\n`;

const LIST_RESULT = {
  result: {
    path: "creatures/",
    entries: [
      { name: "anemone.js", type: "file" },
      { name: "fish.js", type: "file" },
      { name: "minnow.js", type: "file" },
      { name: "s0000.js", type: "file" },
      { name: "snail.js", type: "file" },
    ],
    truncated: false,
  },
};

const SOURCES: Record<string, string> = {
  "creatures/anemone.js": CREATURE_A,
  "creatures/fish.js": CREATURE_B,
  "creatures/minnow.js": `const BODY = "silver";\n`,
  "creatures/s0000.js": `const BODY = "teal";\n`,
  "creatures/s0004.js": `const BODY = "white";\n`,
};

/** Drives the pattern; `read` answers `SOURCES[path]`, `submit` validates. */
function run(opts: {
  rand?: () => number;
  hold?: boolean;
  released?: boolean;
  inject?: Map<number, HeadsUp[]>;
  limitReachedOnSubmit?: boolean;
}): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = SWEEP_COLOUR.next({
      last,
      heads_ups,
      hold: opts.hold ?? false,
      released: opts.released ?? false,
      state,
      attempt_id: "a_test",
      rand: opts.rand ?? agentRandom(7, 0),
    });
    state = step.state;
    if (step.kind === "tool") {
      calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
      const call = calls[calls.length - 1] as Call;
      if (call.tool === "list") last = LIST_RESULT;
      else if (call.tool === "read")
        last = { result: { path: call.args.path, content: SOURCES[call.args.path as string] ?? "" } };
      else if (call.tool === "submit")
        last = opts.limitReachedOnSubmit
          ? { error: { code: "limit_reached", message: "x" } }
          : { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      else last = { result: {} };
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

/** An L1 `repair` heads-up: `added` names the files the landing added to `creatures/`. */
function l1Repair(hn: number, added: string[]): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "listing", key: "creatures/" },
        rule: "L1",
        result: "repair",
        reason: "sweep_incomplete",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "listing", added, removed: [] },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("sweep-colour (02-tidepool.md 10.3)", () => {
  it("has the truth list of the row: `listing:creatures/`", () => {
    expect([...SWEEP_COLOUR.truth]).toEqual(["listing:creatures/"]);
  });

  it("reads and repaints the first four kinds in name order, then submits", () => {
    const { calls } = run({});
    // anemone, fish, minnow, s0000 — `snail.js` sorts after `s000*.js` ('n' > '0').
    expect(calls.map((call) => call.tool)).toEqual([
      "list",
      "read",
      "read",
      "read",
      "read",
      "replace",
      "replace",
      "replace",
      "replace",
      "submit",
    ]);
    expect((calls[1] as Call).args).toEqual({ path: "creatures/anemone.js" });
    expect((calls[4] as Call).args).toEqual({ path: "creatures/s0000.js" });
    // The first colour constant of each file steps one palette name forward.
    expect((calls[5] as Call).args).toEqual({
      path: "creatures/anemone.js",
      old: 'const ARMS = "pink";',
      new: 'const ARMS = "brown";',
    });
    expect((calls[6] as Call).args).toEqual({
      path: "creatures/fish.js",
      old: 'const BODY = "orange";',
      new: 'const BODY = "yellow";',
    });
  });

  it("repair (L1): reads and repaints each added file, then acknowledges", () => {
    // The landing adds `s0004.js` while the sweep is mid-script.
    const inject = new Map([[5, [l1Repair(1, ["s0004.js"])]]]);
    const { calls } = run({ inject });
    const tools = calls.map((call) => call.tool);
    // The added file is read and repainted before the submit.
    expect(tools).toEqual([
      "list",
      "read",
      "read",
      "read",
      "read",
      "read", // creatures/s0004.js
      "replace",
      "replace",
      "replace",
      "replace",
      "replace",
      "submit",
    ]);
    expect((calls[5] as Call).args).toEqual({ path: "creatures/s0004.js" });
    expect((calls[10] as Call).args).toEqual({
      path: "creatures/s0004.js",
      old: 'const BODY = "white";',
      new: 'const BODY = "black";',
    });
    expect((calls[11] as Call).args).toEqual({
      summary: "repaint the first four creatures",
      acknowledge: [1],
      statement: "repainted the added files",
    });
  });

  it("SW7: a second `repair` heads-up ends the attempt `withdrawn`", () => {
    const inject = new Map([
      [5, [l1Repair(1, ["s0004.js"])]],
      [11, [l1Repair(2, ["s0005.js"])]],
    ]);
    const { outcome, calls } = run({ inject });
    expect(outcome).toBe("stop");
    expect(calls.map((c) => c.tool)).toContain("read");
  });

  it("SW7: `limit_reached` ends the attempt `withdrawn`", () => {
    const { outcome } = run({ limitReachedOnSubmit: true });
    expect(outcome).toBe("stop");
  });

  it("SW8/SWR3: a held sweep waits before submit until released", () => {
    const calls: Call[] = [];
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    const rand = agentRandom(7, 0);
    for (let i = 0; i < 15; i += 1) {
      const step = SWEEP_COLOUR.next({
        last,
        heads_ups: [],
        hold: true,
        released: false,
        state,
        attempt_id: "a_test",
        rand,
      });
      state = step.state;
      if (step.kind === "wait") break;
      if (step.kind === "tool") {
        calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
        const call = calls[calls.length - 1] as Call;
        last =
          call.tool === "list"
            ? LIST_RESULT
            : call.tool === "read"
              ? { result: { content: SOURCES[call.args.path as string] ?? "" } }
              : { result: {} };
      }
    }
    expect(calls.map((call) => call.tool)).toEqual([
      "list",
      "read",
      "read",
      "read",
      "read",
      "replace",
      "replace",
      "replace",
      "replace",
    ]);
    const step = SWEEP_COLOUR.next({
      last,
      heads_ups: [],
      hold: true,
      released: true,
      state,
      attempt_id: "a_test",
      rand,
    });
    expect((step as { tool?: string }).tool).toBe("submit");
  });
});
