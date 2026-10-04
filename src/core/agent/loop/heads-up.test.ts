// Heads-up delivery and model rendering: the `inbox_cases` of docs/spec/premise-cases.json (HU6a),
// receiveHeadsUp's order and dedupe (HU5), and toHeadsUpForModel (MR6 to MR9) against the exact
// heads-up of the worked example of 05-agent.md 3.8.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inboxNext, receiveHeadsUp, toHeadsUpForModel, headsUpUserMessage, labelOf } from "./heads-up.ts";
import { newLoopState } from "./state.ts";
import type { HeadsUp, HeadsUpItem } from "../../../protocol/headsup.ts";
import { AGENT_TEXTS } from "../../../protocol/agent-prompt.ts";

const SUFFIX = (JSON.parse(AGENT_TEXTS) as { suffix: Record<string, string> }).suffix;

const cases = JSON.parse(readFileSync("docs/spec/premise-cases.json", "utf8")) as {
  inbox_cases: Array<{
    id: string;
    rule: string;
    shown_hn: number;
    inbox: number[];
    expect: { show: number[]; sync: boolean };
  }>;
};

function headsUpOf(hn: number, over: Partial<HeadsUp> = {}): HeadsUp {
  return {
    hn,
    attempt_id: "a_test",
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [1], changes: [{ seq: 1, change_id: "c_x", intent_text: "t" }] },
    items: [],
    dropped_ops: [],
    go_around: 1,
    head_seq: 1,
    created_at: 0,
    ...over,
  };
}

describe("inboxNext (HU6a)", () => {
  for (const c of cases.inbox_cases) {
    it(`${c.id} ${c.rule}: shown_hn ${c.shown_hn}, inbox [${c.inbox}] -> show [${c.expect.show}], sync ${c.expect.sync}`, () => {
      const inbox = c.inbox.map((hn) => ({ heads_up: headsUpOf(hn), shown_step: null, received_at: 0 }));
      const { show, sync } = inboxNext(c.shown_hn, inbox);
      expect(show.map((hu) => hu.hn)).toEqual(c.expect.show);
      expect(sync).toBe(c.expect.sync);
    });
  }
});

describe("receiveHeadsUp (HU5)", () => {
  it("keeps heads-ups in ascending hn even when pushed out of order", () => {
    const state = newLoopState();
    receiveHeadsUp(state, headsUpOf(3), 1);
    receiveHeadsUp(state, headsUpOf(1), 2);
    receiveHeadsUp(state, headsUpOf(2), 3);
    expect(state.inbox.map((e) => e.heads_up.hn)).toEqual([1, 2, 3]);
  });
  it("stores a duplicate hn once and returns the existing entry", () => {
    const state = newLoopState();
    const first = receiveHeadsUp(state, headsUpOf(1), 1);
    const again = receiveHeadsUp(state, headsUpOf(1, { wake: false }), 2);
    expect(state.inbox).toHaveLength(1);
    expect(again).toBe(first);
    expect(state.inbox[0]?.heads_up.wake).toBe(true);
  });
});

// The heads-up of worked example 2 (05-agent.md 3.8), verbatim.
const EXAMPLE_38: HeadsUp = {
  hn: 1,
  attempt_id: "a_01JB2M7B5D9F3H7K1N5R9T3V7X",
  result: "repair",
  wake: true,
  cause: {
    type: "landing",
    seqs: [1],
    changes: [{ seq: 1, change_id: "c_01JB2M9D8F2H6K0M4Q8S2U6W0Y", intent_text: "make energy a fraction from 0 to 1" }],
  },
  items: [
    {
      premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
      rule: "E2",
      result: "repair",
      reason: "referenced_entity_changed",
      old_hash: "5149f012fe7cd2dfd8820a214ea41ff0",
      new_hash: "f52fdb40e9972b45534f0361ecb65cea",
      cause_seq: 1,
      diff: {
        kind: "entity",
        before: "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
        after: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
      },
      uses: [
        {
          path: "creatures/crab.js",
          entity: "(import ../world/energy.js)",
          line: 1,
          text: 'import { ENERGY_MAX } from "../world/energy.js";',
        },
        {
          path: "creatures/crab.js",
          entity: "spawn",
          line: 8,
          text: "  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
        },
      ],
    },
  ],
  dropped_ops: [],
  go_around: 1,
  head_seq: 1,
  created_at: 1791655421000,
};

describe("toHeadsUpForModel (MR6-MR9)", () => {
  it("MR6/MR7/MR8: maps the 3.8 heads-up to exactly the object the example shows", () => {
    const out = toHeadsUpForModel(EXAMPLE_38);
    expect(out).toEqual({
      hn: 1,
      action: "repair",
      because:
        "Another change landed while you were working and changed something your change depends on, so check all of your work against the new version, fix what relied on the old one, and call submit with a statement.",
      changed_by: "make energy a fraction from 0 to 1",
      items: [
        {
          what: "`ENERGY_MAX` in world/energy.js changed, and your code references it. Anything in your files that relied on its old value or behaviour must change too, not only the lines in your_lines.",
          before:
            "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
          after: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
          your_lines: [
            'creatures/crab.js:1 [(import ../world/energy.js)] import { ENERGY_MAX } from "../world/energy.js";',
            "creatures/crab.js:8 [spawn]   return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
          ],
        },
      ],
      dropped_edits: [],
    });
  });

  it("MR6 action: info -> none, confirm -> confirm, repair -> repair", () => {
    expect(toHeadsUpForModel(headsUpOf(1, { result: "info" })).action).toBe("none");
    expect(toHeadsUpForModel(headsUpOf(1, { result: "confirm" })).action).toBe("confirm");
    expect(toHeadsUpForModel(headsUpOf(1, { result: "repair" })).action).toBe("repair");
  });

  it("MR6 because: texts.because[cause.type][action], one sentence", () => {
    const undo = headsUpOf(1, { cause: { type: "undo", seqs: [4], changes: [] }, result: "confirm" });
    expect(toHeadsUpForModel(undo).because.length).toBeGreaterThan(0);
    const infoLanding = headsUpOf(1, { result: "info" });
    expect(toHeadsUpForModel(infoLanding).because).toContain("landed");
  });

  it("MR6 changed_by: non-null intent texts in ascending seq joined by ' / ', null when none", () => {
    const hu = headsUpOf(1, {
      cause: {
        type: "landing",
        seqs: [2, 1, 3],
        changes: [
          { seq: 2, change_id: "c_b", intent_text: "second" },
          { seq: 1, change_id: "c_a", intent_text: "first" },
          { seq: 3, change_id: "c_c", intent_text: null },
        ],
      },
    });
    expect(toHeadsUpForModel(hu).changed_by).toBe("first / second");
    const none = headsUpOf(1, {
      cause: { type: "undo", seqs: [1], changes: [{ seq: 1, change_id: "c", intent_text: null }] },
    });
    expect(toHeadsUpForModel(none).changed_by).toBeNull();
  });

  it("MR7: your_lines is the last key of each item", () => {
    const item = toHeadsUpForModel(EXAMPLE_38).items[0];
    const keys = Object.keys(item as object);
    expect(keys[keys.length - 1]).toBe("your_lines");
  });

  it("MR7: a file diff carries before null, after = unified, and the file_diff suffix", () => {
    const item: HeadsUpItem = {
      premise: { kind: "file", key: "creatures/fish.js" },
      rule: "F1",
      result: "confirm",
      reason: "file_changed",
      old_hash: "a",
      new_hash: "b",
      cause_seq: 1,
      diff: { kind: "file", before_oid: "a", after_oid: "b", unified: "@@ -1 +1 @@", changed_entities: ["spawn"] },
      uses: [],
    };
    const out = toHeadsUpForModel(headsUpOf(1, { result: "confirm", items: [item] })).items[0] as Record<
      string,
      unknown
    >;
    expect(out.before).toBeNull();
    expect(out.after).toBe("@@ -1 +1 @@");
    expect(out.your_lines).toEqual([]);
    // The file_diff suffix sentence is appended to `what` (MR7).
    expect(String(out.what)).toContain(SUFFIX.file_diff as string);
  });

  it("MR7: a pending item carries checking: true", () => {
    const item: HeadsUpItem = {
      premise: { kind: "check", key: "imports_resolve" },
      rule: "CKL",
      result: "pending",
      reason: "check_pending",
      old_hash: "a",
      new_hash: "b",
      cause_seq: null,
      diff: { kind: "check", check: "imports_resolve", code: "pending" },
      uses: [],
    };
    const out = toHeadsUpForModel(headsUpOf(1, { result: "info", items: [item] })).items[0] as Record<string, unknown>;
    expect(out.checking).toBe(true);
  });

  it("MR6 dropped_edits: one {path, why} per dropped op, {n} filled with op_seq", () => {
    const hu = headsUpOf(1, {
      dropped_ops: [{ op_seq: 7, path: "creatures/fish.js", rule: "OP1" }],
    });
    const out = toHeadsUpForModel(hu);
    expect(out.dropped_edits).toEqual([{ path: "creatures/fish.js", why: expect.stringContaining("op_seq 7") }]);
  });

  it("MR9: omits hashes, rule/reason ids, seqs, ids, wake and timestamps", () => {
    const text = JSON.stringify(toHeadsUpForModel(EXAMPLE_38));
    for (const leaked of [
      "5149f012",
      "f52fdb40",
      "referenced_entity_changed",
      "go_around",
      "head_seq",
      "created_at",
      "attempt_id",
      "change_id",
      "cause_seq",
      "E2",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("labelOf (MR8)", () => {
  it.each([
    [{ kind: "entity", key: "world/energy.js#ENERGY_MAX" }, "`ENERGY_MAX` in world/energy.js"],
    [
      { kind: "entity", key: "creatures/crab.js#(import ../world/energy.js)" },
      "the imports from ../world/energy.js in creatures/crab.js",
    ],
    [{ kind: "entity", key: "a.js#(top)" }, "the top-level statements of a.js"],
    [{ kind: "entity", key: "a.js#default" }, "the default export of a.js"],
    [{ kind: "entity", key: "a.js#*x" }, "the re-export of x in a.js"],
    [{ kind: "file", key: "creatures/fish.js" }, "the file creatures/fish.js"],
    [{ kind: "listing", key: "creatures/" }, "the directory creatures/"],
    [{ kind: "query", key: "text:creatures/:foo" }, 'your search for "foo" in creatures/'],
    [{ kind: "query", key: "outline:world/energy.js" }, "the outline of world/energy.js"],
    [{ kind: "query", key: "refs:world/energy.js#ENERGY_MAX" }, "`ENERGY_MAX` in world/energy.js"],
    [{ kind: "check", key: "imports_resolve" }, "the check imports_resolve"],
  ])("%o -> %s", (premise, label) => {
    expect(labelOf(premise.kind, premise.key)).toBe(label);
  });
});

describe("headsUpUserMessage (SP5)", () => {
  it("is JSON.stringify({ heads_ups: [...] }) written by MR6", () => {
    const text = headsUpUserMessage([EXAMPLE_38]);
    expect(text).toBe(JSON.stringify({ heads_ups: [toHeadsUpForModel(EXAMPLE_38)] }));
    const parsed = JSON.parse(text) as { heads_ups: Array<{ hn: number }> };
    expect(parsed.heads_ups[0]?.hn).toBe(1);
  });
});
