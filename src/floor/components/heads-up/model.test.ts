// The heads-up panel's view model (03-floor 3.4): titles, cause lines, one block per `diff.kind`,
// and the closing lines. Expected strings are the spec's own sentences of 5.6 (BP1), read off the
// copy tables — never this module's output.

import { describe, expect, it } from "vitest";
import type { HeadsUp, HeadsUpItem } from "../../../protocol/headsup.ts";
import type { AttemptView, HeadsUpView } from "../../../protocol/reducer/state.ts";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import { headsUpModel } from "./model.ts";

function attemptView(state: AttemptView["state"] = "working", agent: "real" | "synthetic" = "real"): AttemptView {
  const floor = emptyFloorState();
  floor.pool.id = "pool";
  reduce(floor, {
    n: 1, t: 1, ts: 1, src: "trunk", pool: "pool", type: "intent.created",
    intent_id: "i_1", text: "a crab", requester: "owner", race: false, prewritten: false,
  });
  reduce(floor, {
    n: 2, t: 2, ts: 2, src: "trunk", pool: "pool", type: "attempt.opened",
    attempt_id: "a_1", intent_id: "i_1", change_id: "c_1", agent, model: "model-a", race: false,
  });
  const attempt = floor.attempts["a_1"]!;
  attempt.state = state;
  return attempt;
}

function headsupView(over: Partial<HeadsUpView> = {}): HeadsUpView {
  return {
    hn: 1,
    result: "repair",
    wake: true,
    ts: 10,
    cause: {
      type: "landing",
      seqs: [9],
      changes: [{ seq: 9, change_id: "c_9", intent_text: "make energy a fraction" }],
    },
    go_around: 1,
    keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
    items: [],
    dropped_ops: [],
    resolved: null,
    ...over,
  };
}

function entityItem(over: Partial<HeadsUpItem> = {}): HeadsUpItem {
  return {
    premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
    rule: "E2",
    result: "repair",
    reason: "referenced_entity_changed",
    old_hash: "h0",
    new_hash: "h1",
    cause_seq: 9,
    diff: { kind: "entity", before: "export const ENERGY_MAX = 100;", after: "export const ENERGY_MAX = 1;" },
    uses: [{ path: "creatures/crab.js", entity: "world/energy.js#ENERGY_MAX", line: 1, text: 'import { ENERGY_MAX } from "../world/energy.js";' }],
    ...over,
  };
}

describe("headsUpModel (03 3.4)", () => {
  it("title follows the result: repair, confirm, info (5.4)", () => {
    const attempt = attemptView();
    expect(headsUpModel(headsupView({ result: "repair", go_around: 2 }), attempt).title).toBe(
      "Heads-up 1 · go-around 2",
    );
    expect(headsUpModel(headsupView({ result: "confirm", go_around: null }), attempt).title).toBe(
      "Heads-up 1 · one confirm needed",
    );
    expect(headsUpModel(headsupView({ result: "info" }), attempt).title).toBe(
      "Heads-up 1 · for information",
    );
  });

  it("the edge is red for repair, amber for confirm, neutral for info, holds once resolved", () => {
    const attempt = attemptView();
    expect(headsUpModel(headsupView({ result: "repair" }), attempt).tone).toBe("changed");
    expect(headsUpModel(headsupView({ result: "confirm" }), attempt).tone).toBe("confirm");
    expect(headsUpModel(headsupView({ result: "info" }), attempt).tone).toBe("neutral");
    expect(
      headsUpModel(
        headsupView({ resolved: { statement: "done", changed: true, ts: 20 } }),
        attempt,
      ).tone,
    ).toBe("holds");
  });

  it("the cause line names the landing's intent text and seq", () => {
    expect(headsUpModel(headsupView(), attemptView()).cause).toBe(
      'Changed by: "make energy a fraction" (landing 9)',
    );
  });
  it("cause undo and revert name the landings they came from", () => {
    const undo = headsupView({ cause: { type: "undo", seqs: [9], changes: [] } });
    expect(headsUpModel(undo, attemptView()).cause).toBe("Changed by: the undo of landing 9");
    const revert = headsupView({ cause: { type: "revert", seqs: [9, 10], changes: [] } });
    expect(headsUpModel(revert, attemptView()).cause).toBe(
      "Changed by: the green line took back landing 9, landing 10",
    );
    const submit = headsupView({ cause: { type: "submit", seqs: [], changes: [] } });
    expect(headsUpModel(submit, attemptView()).cause).toBe("Found when the agent submitted.");
  });

  it("an entity item carries its rule sentence and both sources", () => {
    const model = headsUpModel(headsupView({ items: [entityItem()] }), attemptView());
    const block = model.items![0]!;
    expect(block.kind).toBe("entity");
    expect(block.sentence).toBe("ENERGY_MAX in world/energy.js changed, and this change uses it.");
    expect(block.before).toBe("export const ENERGY_MAX = 100;");
    expect(block.after).toBe("export const ENERGY_MAX = 1;");
    expect(block.uses[0]).toEqual({
      path: "creatures/crab.js",
      line: 1,
      text: 'import { ENERGY_MAX } from "../world/energy.js";',
    });
  });

  it("a blind-spot entity item has no before (3.4: 'a blind spot has no before')", () => {
    const blind = entityItem({ diff: { kind: "entity", before: null, after: "use ENERGY_MAX" } });
    const block = headsUpModel(headsupView({ items: [blind] }), attemptView()).items![0]!;
    expect(block.before).toBeNull();
    expect(block.after).toBe("use ENERGY_MAX");
  });

  it("a listing diff fills headsup.added and headsup.removed lists", () => {
    const listing = entityItem({
      premise: { kind: "listing", key: "creatures/" },
      rule: "L1",
      reason: "sweep_incomplete",
      diff: { kind: "listing", added: ["creatures/crab.js"], removed: ["creatures/old.js"] },
    });
    const block = headsUpModel(headsupView({ items: [listing] }), attemptView()).items![0]!;
    expect(block.added).toEqual(["creatures/crab.js"]);
    expect(block.removed).toEqual(["creatures/old.js"]);
  });

  it("a check diff names the check through its 5.7 label", () => {
    const check = entityItem({
      premise: { kind: "check", key: "build" },
      rule: "CKL",
      reason: "checks_failed_at_landing",
      diff: { kind: "check", check: "build", code: "build_failed" },
    });
    const block = headsUpModel(headsupView({ items: [check] }), attemptView()).items![0]!;
    expect(block.checkLabel).toContain("build");
  });

  it("dropped edits carry headsup.dropped with the path", () => {
    const model = headsUpModel(
      headsupView({ dropped_ops: [{ op_seq: 3, path: "creatures/crab.js", rule: "OP1" }] }),
      attemptView(),
    );
    expect(model.dropped).toEqual(["An edit to creatures/crab.js no longer applies. The agent must make it again."]);
  });

  it("resolved panels close with the agent's statement; a stopped attempt's wait gets headsup.waits", () => {
    const resolved = headsupView({ resolved: { statement: "below 0.3 now", changed: true, ts: 20 } });
    expect(headsUpModel(resolved, attemptView()).tail?.sentence).toBe('The agent said: "below 0.3 now"');
    const waiting = headsupView({ result: "confirm" });
    expect(headsUpModel(waiting, attemptView("stopped")).tail?.sentence).toBe(
      "The agent stopped before it answered this.",
    );
    const info = headsupView({ result: "info" });
    expect(headsUpModel(info, attemptView()).tail?.sentence).toBe(
      "The agent was told. Nothing has to change.",
    );
  });

  it("items null (summary_only) reduces to the rule sentences of the keys plus no_diff (AC26)", () => {
    const model = headsUpModel(headsupView({ items: null }), attemptView());
    expect(model.items).toBeNull();
    expect(model.keySentences).toHaveLength(1);
    expect(model.keySentences[0]).toContain("ENERGY_MAX in world/energy.js");
  });
});
