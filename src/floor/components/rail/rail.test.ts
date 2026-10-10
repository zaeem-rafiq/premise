import { afterEach, expect, it, vi } from "vitest";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShellContext, makeShell } from "../../app/context.ts";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { Rail, workingItems, workingOrder } from "./rail.tsx";

afterEach(() => vi.restoreAllMocks());

const SETTINGS: FloorJson = {
  default_pool: "test",
  swarm_pool: "swarm",
  related: "",
  prewritten: [],
  models: {},
  limits: [],
  features: {
    race: true,
    held: true,
    undo: true,
    clef: false,
    green: "none",
    attempt_repos: false,
    mcp: false,
    text_merge: false,
  },
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
};

it("D10 / CO13, RC7: a reopened chosen candidate returns as its own attempt card", () => {
  const floor = emptyFloorState();
  reduce(floor, {
    type: "intent.created",
    n: 1,
    t: 1,
    ts: 1,
    src: "trunk",
    pool: "p",
    intent_id: "i",
    text: "a crab",
    requester: "owner",
    race: true,
    prewritten: false,
  });
  for (let i = 1; i <= 3; i++) {
    reduce(floor, {
      type: "attempt.opened",
      n: i + 1,
      t: i + 1,
      ts: i + 1,
      src: "trunk",
      pool: "p",
      attempt_id: `a${i}`,
      intent_id: "i",
      change_id: `c${i}`,
      agent: "real",
      model: "model",
      race: true,
    });
  }
  floor.attempts.a1!.state = "working";
  floor.attempts.a1!.reopened_by = "undo";
  for (const id of ["a2", "a3"]) {
    floor.attempts[id]!.state = "stopped";
    floor.attempts[id]!.stop_reason = "not_chosen";
  }
  expect(workingItems(floor, workingOrder(floor))).toEqual([{ kind: "attempt", attempt: floor.attempts.a1 }]);
});

it("D15 / FL3, 3.8, 3.19: the Landed tab counts confirmed changes, excluding pending and undo landings", () => {
  const floor = emptyFloorState();
  function html() {
    return renderToStaticMarkup(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(Rail, {
          floor,
          mode: "live",
          owner: true,
          visitor: false,
          clock: floor.ts,
          dwellMs: 1200,
          capReached: false,
          onSend: () => {},
          onOpenCard: () => {},
        }),
      ),
    );
  }
  function accept(n: number, seq: number, kind: "change" | "undo") {
    reduce(floor, {
      type: "landing.accepted",
      n,
      t: n,
      ts: n,
      pool: "p",
      src: "trunk",
      seq,
      batch_id: seq,
      kind,
      attempt_id: null,
      change_id: `c${seq}`,
      intent_id: null,
      request_id: null,
      paths: [],
      writes: [],
    });
  }
  function land(n: number, seq: number) {
    reduce(floor, {
      type: "landing.landed",
      n,
      t: n,
      ts: n,
      pool: "p",
      src: "trunk",
      seq,
      batch_id: seq,
      commit: `c${seq}`,
      tree: "tree",
      note: "note",
      note_json: "{}",
      time_to_land_ms: 1,
    });
  }
  accept(1, 1, "change");
  expect(html()).toContain("Landed 0");
  land(2, 1);
  expect(html()).toContain("Landed 1");
  accept(3, 2, "undo");
  land(4, 2);
  accept(5, 3, "change");
  expect(html()).toContain("Landed 1");
});

it("D37 / CO12, FL9: a mounted rail never restarts an old landing's dwell", () => {
  vi.spyOn(Date, "now").mockReturnValue(100_000);
  const floor = emptyFloorState();
  reduce(floor, {
    type: "intent.created",
    n: 1,
    t: 1,
    ts: 1,
    pool: "p",
    src: "trunk",
    intent_id: "i",
    text: "a crab",
    requester: "owner",
    race: false,
    prewritten: false,
  });
  reduce(floor, {
    type: "attempt.opened",
    n: 2,
    t: 2,
    ts: 2,
    pool: "p",
    src: "trunk",
    attempt_id: "a",
    intent_id: "i",
    change_id: "c",
    agent: "real",
    model: "m",
    race: false,
  });
  reduce(floor, {
    type: "landing.accepted",
    n: 3,
    t: 3,
    ts: 3,
    pool: "p",
    src: "trunk",
    seq: 1,
    batch_id: 1,
    kind: "change",
    attempt_id: "a",
    change_id: "c",
    intent_id: "i",
    request_id: null,
    paths: [],
    writes: [],
  });
  reduce(floor, {
    type: "landing.landed",
    n: 4,
    t: 4,
    ts: 1000,
    pool: "p",
    src: "trunk",
    seq: 1,
    batch_id: 1,
    commit: "commit",
    tree: "tree",
    note: "note",
    note_json: "{}",
    time_to_land_ms: 1,
  });
  floor.attempts.a!.state = "landed";
  floor.attempts.a!.landed_seq = 1;
  function html(clock: number, mode: "live" | "replay" = "live", dwellMs = 1200) {
    return renderToStaticMarkup(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, mode === "replay") },
        createElement(Rail, {
          floor,
          mode,
          owner: true,
          visitor: false,
          clock,
          dwellMs,
          capReached: false,
          onSend: () => {},
          onOpenCard: () => {},
        }),
      ),
    );
  }
  expect(html(1000)).toContain("Working 1");
  expect(html(2199)).toContain("Working 1");
  expect(html(2200)).toContain("Working 0");
  expect(html(5000)).toContain("Working 0");
  expect(html(5000, "replay")).toContain("Working 0");
  expect(html(2199, "replay")).toContain("Working 1");
  expect(html(2999, "replay", 2000)).toContain("Working 1");
  expect(html(3000, "replay", 2000)).toContain("Working 0");
});
