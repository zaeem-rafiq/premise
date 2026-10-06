// Unit tests of the scripted-pattern helpers of 02-tidepool.md 10.3 — above all the fresh
// creature name: `creatures/s-<id>.js`, `<id>` the first 10 characters of the attempt id
// after `a_`, in lower case. Expected values come from that rule, never from output (BP1).

import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../protocol/headsup.ts";
import type { ModelToolMessage } from "../protocol/tools.ts";
import type { PatternTurn } from "./pattern.ts";
import { ADD_PLAIN } from "./patterns/add-plain.ts";
import { agentRandom } from "./prng.ts";
import { freshName } from "./scripted.ts";

/** The kind-name rule of 02-tidepool.md 2.6. */
const KIND_NAME = /^[a-z][a-z0-9-]{0,30}$/;

describe("freshName (02-tidepool.md 10.3): a fresh name is the agent's own", () => {
  it("is `creatures/s-<id>.js`, `<id>` the first 10 characters after `a_`, in lower case", () => {
    expect(freshName("a_0123456789ABCDEF")).toBe("creatures/s-0123456789.js");
    expect(freshName("a_add")).toBe("creatures/s-add.js");
  });

  it("two attempt ids give two names", () => {
    expect(freshName("a_first")).toBe("creatures/s-first.js");
    expect(freshName("a_second")).toBe("creatures/s-second.js");
    expect(freshName("a_first")).not.toBe(freshName("a_second"));
  });

  it("the name is a valid kind name of 2.6", () => {
    for (const id of ["a_0123456789abcdef", "a_x", "a_held", "a_heldbeforesubmit"]) {
      const kind = freshName(id).slice("creatures/".length, -".js".length);
      expect(kind).toMatch(KIND_NAME);
      expect(kind).not.toBe("constructor");
    }
  });

  it("a restart gives the same name: the replayed turn issues the same write", () => {
    // Drive add-plain through the script, then replay the write's turn from the carried
    // state the way a restarted driver replays it (same attempt id, same durable state):
    // the write names the same `s-<id>` — the replay draws nothing for the name.
    const rand = agentRandom(7, 0);
    let state: unknown = null;
    let last: ModelToolMessage | null = null;
    const turn = (): PatternTurn => ({
      last,
      heads_ups: [] as HeadsUp[],
      hold: false,
      released: false,
      attempt_id: "a_replay",
      state,
      rand,
    });
    for (let i = 0; i < 5; i += 1) {
      const step = ADD_PLAIN.next(turn());
      expect(step.kind).toBe("tool");
      state = step.state;
      last = { result: {} };
    }
    const replayed = ADD_PLAIN.next(turn());
    expect(replayed.kind).toBe("tool");
    if (replayed.kind === "tool") {
      expect(replayed.tool).toBe("write");
      // `a_replay` -> `s-replay` by the rule.
      expect(replayed.args).toMatchObject({ path: "creatures/s-replay.js" });
    }
  });
});
