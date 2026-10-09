import { expect, it } from "vitest";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import { autoExpandedPanels } from "./auto-expand.ts";

it("D13 / CO11, VD17: only the two newest heads-up panels across all attempts open automatically", () => {
  const floor = emptyFloorState();
  for (let i = 1; i <= 3; i++) {
    reduce(floor, {
      type: "attempt.opened",
      n: i * 2,
      t: i * 2,
      ts: i * 2,
      pool: "p",
      src: "trunk",
      attempt_id: `a${i}`,
      intent_id: "i",
      change_id: `c${i}`,
      agent: "real",
      model: "m",
      race: true,
    });
    reduce(floor, {
      type: "headsup.sent",
      n: i * 2 + 1,
      t: i * 2 + 1,
      ts: i * 2 + 1,
      pool: "p",
      src: "trunk",
      attempt_id: `a${i}`,
      hn: 1,
      result: "repair",
      wake: true,
      cause: { type: "submit", seqs: [], changes: [] },
      keys: [],
      items: [],
      dropped_ops: [],
      go_around: 1,
    });
  }
  expect(autoExpandedPanels(floor)).toEqual([
    { attemptId: "a2", hn: 1 },
    { attemptId: "a3", hn: 1 },
  ]);
  reduce(floor, {
    type: "headsup.sent",
    n: 8,
    t: 8,
    ts: 8,
    pool: "p",
    src: "trunk",
    attempt_id: "a2",
    hn: 2,
    result: "confirm",
    wake: true,
    cause: { type: "submit", seqs: [], changes: [] },
    keys: [],
    items: [],
    dropped_ops: [],
    go_around: null,
  });
  expect(autoExpandedPanels(floor)).toEqual([
    { attemptId: "a3", hn: 1 },
    { attemptId: "a2", hn: 2 },
  ]);
});

it("D13 / CO11: two newest panels may belong to the same attempt", () => {
  const floor = emptyFloorState();
  reduce(floor, {
    type: "attempt.opened",
    n: 1,
    t: 1,
    ts: 1,
    pool: "p",
    src: "trunk",
    attempt_id: "a",
    intent_id: "i",
    change_id: "c",
    agent: "real",
    model: "m",
    race: false,
  });
  for (const hn of [1, 2])
    reduce(floor, {
      type: "headsup.sent",
      n: hn + 1,
      t: hn + 1,
      ts: hn + 1,
      pool: "p",
      src: "trunk",
      attempt_id: "a",
      hn,
      result: "repair",
      wake: true,
      cause: { type: "submit", seqs: [], changes: [] },
      keys: [],
      items: [],
      dropped_ops: [],
      go_around: hn,
    });
  expect(autoExpandedPanels(floor)).toEqual([
    { attemptId: "a", hn: 1 },
    { attemptId: "a", hn: 2 },
  ]);
});
