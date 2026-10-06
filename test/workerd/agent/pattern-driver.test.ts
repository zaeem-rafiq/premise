// The `PatternDriver`'s durable replay (02-tidepool.md 10.3, SW1): the Agent Durable Object
// constructs the driver from its meta on every activation — the same attempt id, seed and
// agent number — and `driver_state` fast-forwards the draw stream to the stored count. A
// turn replayed after a restart therefore sees the same attempt id and draws the same values,
// so the pattern's fresh creature name `creatures/s-<id>.js` is the same.

import { describe, expect, it } from "vitest";
import type { ModelToolMessage } from "../../../src/protocol/tools.ts";
import { PatternDriver } from "../../../src/worker/agent/pattern-driver.ts";
import { patternById } from "../../../src/swarm/pattern.ts";

function opts(attempt_id: string) {
  return { seed: 7, agent_n: 0, hold: false, attempt_id, released: () => false };
}

describe("PatternDriver (02-tidepool 10.3): the attempt's own fresh name", () => {
  it("a restart gives the same name: the replayed turn re-issues the same write", async () => {
    const pattern = patternById("add-plain");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    const first = new PatternDriver(pattern, opts("a_0123456789abcdef"));
    // Drive the script's five calls (list, GUIDE.md, three entity reads), each answered ok;
    // `state` is the durable `driver_state` the Agent carries between turns.
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    for (let i = 0; i < 5; i += 1) {
      const step = await first.next({ last, state });
      expect(step.kind).toBe("tool");
      state = step.state;
      last = { result: {} };
    }
    // The restart: a fresh driver built from the same meta continues from the durable state.
    const second = new PatternDriver(pattern, opts("a_0123456789abcdef"));
    const write = await second.next({ last, state });
    expect(write.kind).toBe("tool");
    if (write.kind !== "tool") return;
    expect(write.tool).toBe("write");
    // `a_0123456789abcdef` -> `s-0123456789`: the first 10 after `a_`, in lower case (10.3).
    expect(write.args).toMatchObject({ path: "creatures/s-0123456789.js" });
  });

  it("two attempt ids write two different own names", async () => {
    const pattern = patternById("add-plain");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    const paths: string[] = [];
    for (const attempt_id of ["a_0123456789abcdef", "a_ffffffffffff"]) {
      const driver = new PatternDriver(pattern, opts(attempt_id));
      let state: unknown = null;
      let last: ModelToolMessage | null = null;
      // The sixth issued call is the write (after list + four reads).
      for (let i = 0; i < 6; i += 1) {
        const step = await driver.next({ last, state });
        expect(step.kind).toBe("tool");
        state = step.state;
        last = { result: {} };
        if (i === 5) paths.push((step as { args: { path: string } }).args.path);
      }
    }
    // `a_0123456789abcdef` -> `s-0123456789`, `a_ffffffffffff` -> `s-ffffffffff`.
    expect(paths).toEqual(["creatures/s-0123456789.js", "creatures/s-ffffffffff.js"]);
  });
});
