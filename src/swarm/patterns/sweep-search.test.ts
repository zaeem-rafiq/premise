import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { SWEEP_SEARCH } from "./sweep-search.ts";

type Call = { tool: string; args: Record<string, unknown> };

const SEARCH_RESULT = {
  result: {
    query: "wander(creature, 0.05)",
    in: "creatures/",
    lines: [],
    containers: [
      "creatures/s0000.js#update",
      "creatures/s0001.js#update",
      "creatures/s0002.js#update",
      "creatures/s0003.js#update",
    ],
    truncated: false,
  },
};

/** Drives the pattern; `search` answers `SEARCH_RESULT`, reads give the entity source. */
function run(opts: { inject?: Map<number, HeadsUp[]>; secondRepair?: boolean }): { calls: Call[]; outcome: string } {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = SWEEP_SEARCH.next({
      last,
      heads_ups,
      hold: false,
      released: false,
      state,
      rand: agentRandom(7, 0),
    });
    state = step.state;
    if (step.kind === "tool") {
      calls.push({ tool: step.tool, args: step.args as Record<string, unknown> });
      const call = calls[calls.length - 1] as Call;
      if (call.tool === "search") last = SEARCH_RESULT;
      else if (call.tool === "read") last = { result: { key: call.args, source: "x" } };
      else if (call.tool === "submit")
        last = { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      else last = { result: {} };
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

/** A QT1 `repair`: `added` names the container keys the landing added to the query's members. */
function qt1(hn: number, added: string[]): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "query", key: "text:creatures/:wander(creature, 0.05)" },
        rule: "QT1",
        result: "repair",
        reason: "sweep_incomplete",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: {
          kind: "query",
          added: added.map((key) => ({ key, source: "wander(creature, 0.05);" })),
          removed: [],
          context: [],
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

describe("sweep-search (02-tidepool.md 10.3)", () => {
  it("has the truth list of the row: `query:text:creatures/:wander(creature, 0.05)`", () => {
    expect([...SWEEP_SEARCH.truth]).toEqual(["query:text:creatures/:wander(creature, 0.05)"]);
  });

  it("reads the first three containers and widens each, then submits", () => {
    const { calls } = run({});
    expect(calls.map((call) => call.tool)).toEqual([
      "search",
      "read",
      "read",
      "read",
      "replace",
      "replace",
      "replace",
      "submit",
    ]);
    expect((calls[0] as Call).args).toEqual({ path: "creatures/", query: "wander(creature, 0.05)" });
    expect((calls[1] as Call).args).toEqual({ path: "creatures/s0000.js", entity: "update" });
    expect((calls[4] as Call).args).toEqual({
      path: "creatures/s0000.js",
      old: "wander(creature, 0.05)",
      new: "wander(creature, 0.1)",
    });
  });

  it("repair (QT1): the same edit in each added container, then acknowledges", () => {
    const inject = new Map([[5, [qt1(1, ["creatures/s0009.js#update"])]]]);
    const { calls } = run({ inject });
    const tools = calls.map((call) => call.tool);
    // The gained container's file is widened before the submit.
    expect(tools).toEqual(["search", "read", "read", "read", "replace", "replace", "replace", "replace", "submit"]);
    expect((calls[7] as Call).args).toEqual({
      path: "creatures/s0009.js",
      old: "wander(creature, 0.05)",
      new: "wander(creature, 0.1)",
    });
    expect((calls[8] as Call).args).toEqual({
      summary: "widen the wander",
      acknowledge: [1],
      statement: "widened the wander in the new file too",
    });
  });

  it("info (X0): a container gained before its first edit is widened too", () => {
    const info: HeadsUp = { ...qt1(1, ["creatures/s0009.js#update"]), result: "info", wake: false };
    const inject = new Map([[2, [info]]]);
    const { calls } = run({ inject });
    const tools = calls.map((call) => call.tool);
    // The gained container is widened; an `info` carries nothing to acknowledge.
    expect(tools.filter((t) => t === "replace")).toHaveLength(4);
    expect((calls[8] as Call).args).toEqual({ summary: "widen the wander" });
  });

  it("SW7: a second `repair` heads-up ends the attempt `withdrawn`", () => {
    const inject = new Map([
      [5, [qt1(1, ["creatures/s0009.js#update"])]],
      [9, [qt1(2, ["creatures/s0010.js#update"])]],
    ]);
    const { outcome } = run({ inject });
    expect(outcome).toBe("stop");
  });
});
