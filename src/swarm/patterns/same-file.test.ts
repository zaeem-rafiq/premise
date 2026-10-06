import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import { agentRandom } from "../prng.ts";
import type { PatternTurn } from "../pattern.ts";
import { SAME_FILE } from "./same-file.ts";

type Call = { tool: string; args: Record<string, unknown> };

const EMPTY_LIST = { result: { path: "creatures/", entries: [{ name: "d0000.js", type: "file" }], truncated: false } };

/** Drives the pattern; `write` answers `read_first` when `raced`, else ok; `submit` needs a
 * confirm once (B1's blind-spot turn) then validates. */
function run(opts: { rand: () => number; inject?: Map<number, HeadsUp[]>; raced?: boolean }): {
  calls: Call[];
  outcome: string;
} {
  const calls: Call[] = [];
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  let submitted = 0;
  for (let i = 0; i < 40; i += 1) {
    const heads_ups = opts.inject?.get(calls.length) ?? [];
    const step = SAME_FILE.next({
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
      const call = calls[calls.length - 1] as Call;
      if (call.tool === "write")
        last =
          opts.raced && calls.filter((c) => c.tool === "write").length === 1
            ? { error: { code: "read_first", message: "exists" } }
            : { result: { created: true, added: [], altered: [], removed: [], relied_on_by: {} } };
      else if (call.tool === "list") last = EMPTY_LIST;
      else if (call.tool === "submit")
        last =
          (submitted += 1) === 1
            ? { result: { status: "needs_confirm", submit_id: "s_1", tier: "auto", checks: [] } }
            : { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
      else last = { result: {} };
      continue;
    }
    return { calls, outcome: step.kind };
  }
  return { calls, outcome: "limit" };
}

/** An F1+OP5 `repair`: the partner's landing took the name; the write is dropped. */
function f1Repair(hn: number): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [3], changes: [{ seq: 3, change_id: "c_x", intent_text: "t" }] },
    items: [
      {
        premise: { kind: "file", key: "creatures/d6111.js" },
        rule: "F1",
        result: "repair",
        reason: "write_base_changed",
        old_hash: "o",
        new_hash: "n",
        cause_seq: 3,
        diff: { kind: "file", before_oid: "a", after_oid: "b", unified: "", changed_entities: [] },
        uses: [],
      },
    ],
    dropped_ops: [{ op_seq: 0, path: "creatures/d6111.js", rule: "OP5" }],
    go_around: 1,
    head_seq: 3,
    created_at: 0,
  };
}

describe("same-file (02-tidepool.md 10.3)", () => {
  it("writes T-plain to the drawn `creatures/d<number>.js` name, then submits", () => {
    // seed 7, agent 0 draws 0.6111 -> `d6111`; the pair's shared stream gives the same name.
    const { calls } = run({ rand: agentRandom(7, 0) });
    expect(calls.map((call) => call.tool)).toEqual(["write", "submit", "submit"]);
    expect((calls[0] as Call).args.path).toBe("creatures/d6111.js");
    // B1: the write references entities it never read -> `needs_confirm` -> it submits again.
  });

  it("truthOf names the drawn file: `file:creatures/d<number>.js` (the row)", () => {
    expect(SAME_FILE.truthOf?.(agentRandom(7, 0))).toEqual(["file:creatures/d6111.js"]);
    expect(SAME_FILE.truthOf?.(agentRandom(7, 1))).toEqual(["file:creatures/d4826.js"]);
  });

  it("a pair shares the stream: the same `n` draws the same name", () => {
    const a = run({ rand: agentRandom(7, 4) });
    const b = run({ rand: agentRandom(7, 4) });
    expect((b.calls[0] as Call).args).toEqual((a.calls[0] as Call).args);
  });

  it("repair (F1 + OP5): writes the pair's file to its own fresh name", () => {
    const inject = new Map([[1, [f1Repair(1)]]]);
    const { calls } = run({ rand: agentRandom(7, 0), inject });
    const tools = calls.map((call) => call.tool);
    expect(tools).toEqual(["write", "write", "submit", "submit"]);
    // `a_test` -> `s-test`: the agent's own fresh name of 10.3; the listing is not consulted.
    expect((calls[1] as Call).args.path).toBe("creatures/s-test.js");
  });

  it("read_first on the drawn write: writes its own fresh name", () => {
    const { calls } = run({ rand: agentRandom(7, 0), raced: true });
    expect(calls.map((call) => call.tool)).toEqual(["write", "write", "submit", "submit"]);
    expect((calls[1] as Call).args.path).toBe("creatures/s-test.js");
  });

  it("a repair that lands on a `validated` attempt rewrites, not an empty submit (F1 + OP5 pull-back)", () => {
    // The partner's landing took the drawn name after this attempt's submit already validated
    // (GA3): the write is dropped, so the row's answer runs again — write the agent's own
    // fresh name, then submit with the acknowledgement. An empty submit would answer
    // `rejected`.
    const inject = new Map([[3, [f1Repair(2)]]]);
    const { calls } = run({ rand: agentRandom(7, 0), inject });
    expect(calls.map((call) => call.tool)).toEqual(["write", "submit", "submit", "write", "submit"]);
    expect((calls[3] as Call).args.path).toBe("creatures/s-test.js");
    expect((calls[4] as Call).args.acknowledge).toEqual([2]);
  });
});
