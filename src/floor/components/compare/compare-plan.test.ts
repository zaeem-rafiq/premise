// The Compare view's list and its one "no difference" fact: AC24's four sentences, PM3's
// "(approximated)" count, PM4's interrupted label and PM7's tree equality — worked by hand
// from fabricated streams (BP1: expected values come from the spec, never from the page).

import { describe, expect, it } from "vitest";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { PoolEvent } from "../../../protocol/events.ts";
import { conflictCount, diffLines, plainBehind, plainSameAsLanded } from "./compare-plan.ts";

const POOL = "tidepool";

function ev(n: number, fields: Record<string, unknown>): PoolEvent {
  return { n, t: 1_000 + n, ts: 1_000 + n, src: "trunk", pool: POOL, ...fields } as PoolEvent;
}

function poolState(n: number, extra: Record<string, unknown> = {}): PoolEvent {
  return ev(n, {
    type: "pool.state",
    head_seq: 0,
    head_commit: "c-seed",
    green_seq: 0,
    landed_seq: 0,
    landed_commit: "c-seed",
    state: "ready",
    reason: null,
    epoch: 1,
    remote: "https://artifacts.invalid/pool",
    plain_remote: "https://artifacts.invalid/pool-plain",
    rebuild: null,
    unwitnessed: [],
    real_agents: 1,
    max_real_agents: 6,
    synthetic: false,
    summary_only: false,
    ...extra,
  });
}

/** intent.created + attempt.opened + a resolved repair heads-up (hn 1) before acceptance. */
function attemptWithRepair(n: number, attemptId: string, intentId: string, intentText: string): PoolEvent[] {
  return [
    ev(n, {
      type: "intent.created",
      intent_id: intentId,
      text: intentText,
      requester: "owner",
      race: false,
      prewritten: false,
    }),
    ev(n + 1, {
      type: "attempt.opened",
      attempt_id: attemptId,
      intent_id: intentId,
      change_id: `c_${attemptId}`,
      agent: "real",
      model: "model-a",
      race: false,
    }),
    ev(n + 2, {
      type: "headsup.sent",
      attempt_id: attemptId,
      hn: 1,
      result: "repair",
      wake: true,
      cause: { type: "landing", seqs: [0], changes: [] },
      keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
      items: null,
      dropped_ops: [],
      go_around: 1,
    }),
    ev(n + 3, {
      type: "headsup.resolved",
      attempt_id: attemptId,
      hn: 1,
      result: "repair",
      go_around: 1,
      changed: true,
      statement: "Changed the read to the new scale.",
    }),
  ];
}

function landing(
  n: number,
  seq: number,
  attemptId: string,
  intentId: string,
  commit: string,
  tree: string,
): PoolEvent[] {
  return [
    ev(n, {
      type: "landing.accepted",
      seq,
      batch_id: seq,
      kind: "change",
      attempt_id: attemptId,
      change_id: `c_${attemptId}`,
      intent_id: intentId,
      request_id: null,
      paths: ["creatures/crab.js"],
      writes: [],
    }),
    ev(n + 1, {
      type: "landing.landed",
      seq,
      batch_id: seq,
      commit,
      tree,
      note: "note-1",
      note_json: null,
      time_to_land_ms: 1000,
    }),
  ];
}

function plainUpdated(n: number, over: Record<string, unknown> = {}): PoolEvent {
  return ev(n, {
    type: "plain.updated",
    commit: "a".repeat(40),
    tree: "tree-plain",
    through_seq: 1,
    skipped: [],
    interrupted: [],
    ...over,
  });
}

function run(events: PoolEvent[]): FloorState {
  return events.reduce((state, event) => reduce(state, event), emptyFloorState());
}

describe("AC24: the tree-equality fact (PM7, TP20)", () => {
  const base = () => [
    poolState(1),
    ...attemptWithRepair(10, "a_1", "i_1", "make the crab hide"),
    ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "tree-landed-1"),
  ];

  it("plain.updated.tree equals landed.tree of through_seq → plain.no_difference is shown", () => {
    const state = run([...base(), plainUpdated(30, { tree: "tree-landed-1" })]);
    expect(plainSameAsLanded(state)).toBe(true);
  });

  it("the trees differ → the line is not shown", () => {
    const state = run([...base(), plainUpdated(30, { tree: "tree-other" })]);
    expect(plainSameAsLanded(state)).toBe(false);
  });

  it("no plain.updated yet, or through_seq held only as a digest → not shown", () => {
    expect(plainSameAsLanded(run(base()))).toBe(false);
  });
});

describe("AC24: interrupted, the approximated count, and the went-around lines (PM3, PM4)", () => {
  it("a landing in plain.interrupted is labelled plain.interrupted instead of a diff line", () => {
    const state = run([
      poolState(1),
      ...attemptWithRepair(10, "a_1", "i_1", "make the crab hide"),
      ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "tree-landed-1"),
      plainUpdated(30, { interrupted: [1] }),
    ]);
    const lines = diffLines(state);
    expect(lines.map((l) => l.id)).toEqual(["plain.interrupted"]);
    expect(lines[0]?.vars.changeName).toBe('"make the crab hide"');
  });

  it("plain.conflicts carries the skipped count (PM3) — the page adds '(approximated)'", () => {
    const state = run([poolState(1), plainUpdated(10, { skipped: [2, 3], through_seq: 0 })]);
    expect(conflictCount(state)).toBe(2);
    expect(conflictCount(run([poolState(1)]))).toBeNull(); // no plain.updated: unknown, not zero
  });

  it("one repair heads-up → plain.diff_line; several → plain.diff_line.many; a confirm → plain.diff_line.confirm", () => {
    const oneRepair = run([
      poolState(1),
      ...attemptWithRepair(10, "a_1", "i_1", "make the crab hide"),
      ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "tree-landed-1"),
      plainUpdated(30),
    ]);
    const [line] = diffLines(oneRepair);
    expect(line?.id).toBe("plain.diff_line");
    expect(line?.vars).toEqual({ changeName: '"make the crab hide"', keyShort: "ENERGY_MAX" });

    const manyRepairs = run([
      poolState(1),
      ...attemptWithRepair(10, "a_1", "i_1", "make the crab hide"),
      ev(14, {
        type: "headsup.sent",
        attempt_id: "a_1",
        hn: 2,
        result: "repair",
        wake: true,
        cause: { type: "landing", seqs: [0], changes: [] },
        keys: [{ kind: "entity", key: "world/energy.js#drain", rule: "E2" }],
        items: null,
        dropped_ops: [],
        go_around: 2,
      }),
      ev(15, {
        type: "headsup.resolved",
        attempt_id: "a_1",
        hn: 2,
        result: "repair",
        go_around: 2,
        changed: true,
        statement: "fixed",
      }),
      ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "tree-landed-1"),
      plainUpdated(30),
    ]);
    const [many] = diffLines(manyRepairs);
    expect(many?.id).toBe("plain.diff_line.many");
    expect(many?.vars.n).toBe(2);

    const confirmOnly = run([
      poolState(1),
      ev(10, {
        type: "intent.created",
        intent_id: "i_2",
        text: "read energy",
        requester: "owner",
        race: false,
        prewritten: false,
      }),
      ev(11, {
        type: "attempt.opened",
        attempt_id: "a_2",
        intent_id: "i_2",
        change_id: "c_a2",
        agent: "real",
        model: "model-a",
        race: false,
      }),
      ev(12, {
        type: "headsup.sent",
        attempt_id: "a_2",
        hn: 1,
        result: "confirm",
        wake: true,
        cause: { type: "landing", seqs: [0], changes: [] },
        keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "B1" }],
        items: null,
        dropped_ops: [],
        go_around: null,
      }),
      ev(13, {
        type: "headsup.resolved",
        attempt_id: "a_2",
        hn: 1,
        result: "confirm",
        go_around: null,
        changed: false,
        statement: "read it",
      }),
      ...landing(20, 1, "a_2", "i_2", "c".repeat(40), "tree-landed-1"),
      plainUpdated(30),
    ]);
    const [confirm] = diffLines(confirmOnly);
    expect(confirm?.id).toBe("plain.diff_line.confirm");
    expect(confirm?.vars).toEqual({ changeName: '"read energy"', keyShort: "ENERGY_MAX" });
  });

  it("a landed change with no repair or confirm heads-up gets no line (the list may be empty)", () => {
    const state = run([
      poolState(1),
      ev(10, {
        type: "intent.created",
        intent_id: "i_1",
        text: "quiet change",
        requester: "owner",
        race: false,
        prewritten: false,
      }),
      ev(11, {
        type: "attempt.opened",
        attempt_id: "a_1",
        intent_id: "i_1",
        change_id: "c_a1",
        agent: "real",
        model: "model-a",
        race: false,
      }),
      ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "tree-landed-1"),
      plainUpdated(30),
    ]);
    expect(diffLines(state)).toEqual([]);
  });

  it("plain.behind counts the landings the plain pool has not reached (3.6 held row)", () => {
    const state = run([
      poolState(1),
      ...attemptWithRepair(10, "a_1", "i_1", "make the crab hide"),
      ...landing(20, 1, "a_1", "i_1", "c".repeat(40), "t1"),
      ...landing(22, 2, "a_1", "i_1", "d".repeat(40), "t2"),
      ...landing(24, 3, "a_1", "i_1", "e".repeat(40), "t3"),
      plainUpdated(30, { through_seq: 1 }),
    ]);
    expect(plainBehind(state)).toBe(2);
    expect(plainBehind(run([poolState(1)]))).toBe(0);
  });
});
