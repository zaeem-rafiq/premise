// `computeMetrics` (EM5, 01-core 14): the numbers the Floor appends every METRICS_EVERY_MS.
// Expected values are read off the metric definitions of 01-core 14.1 to 14.6 (BP1).

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import type { FloorState } from "./state.ts";
import { emptyFloorState } from "./state.ts";
import { reduce } from "./reduce.ts";
import { computeMetrics } from "./metrics.ts";

let n = 0;
function ev(type: PoolEvent["type"], body: object = {}, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
}

function seeded(): FloorState {
  const state = emptyFloorState();
  reduce(
    state,
    ev(
      "pool.state",
      {
        head_seq: 0,
        head_commit: "s",
        green_seq: 0,
        landed_seq: 0,
        landed_commit: "s",
        state: "ready",
        reason: null,
        epoch: 1,
        remote: "r",
        plain_remote: null,
        rebuild: null,
        unwitnessed: [],
        real_agents: 1,
        max_real_agents: 6,
        synthetic: false,
        summary_only: false,
      },
      0,
    ),
  );
  reduce(
    state,
    ev("intent.created", { intent_id: "i1", text: "x", requester: "o", race: false, prewritten: false }, 0),
  );
  reduce(
    state,
    ev(
      "attempt.opened",
      { attempt_id: "a1", intent_id: "i1", change_id: "c1", agent: "real", model: "m", race: false },
      0,
    ),
  );
  return state;
}

function landed(
  state: FloorState,
  seq: number,
  attemptId: string,
  tsLanded: number,
  tsSubmit: number,
  tsAccepted: number,
): void {
  reduce(
    state,
    ev(
      "submit.result",
      { attempt_id: attemptId, submit_id: `s${seq}`, status: "validated", tier: "auto", checks: [], duplicate: false },
      tsSubmit,
    ),
  );
  reduce(
    state,
    ev(
      "landing.accepted",
      {
        seq,
        batch_id: seq,
        kind: "change",
        attempt_id: attemptId,
        change_id: "c",
        intent_id: "i1",
        request_id: null,
        paths: [`p${seq}.js`],
        writes: [],
      },
      tsAccepted,
    ),
  );
  reduce(
    state,
    ev(
      "landing.landed",
      {
        seq,
        batch_id: seq,
        commit: `c${seq}`,
        tree: `t${seq}`,
        note: "n",
        note_json: null,
        time_to_land_ms: tsLanded - tsSubmit,
      },
      tsLanded,
    ),
  );
}

describe("computeMetrics over the trailing window (01-core 14)", () => {
  it("14.1 landings_per_second: confirmed changes in the window over window seconds", () => {
    const state = seeded();
    landed(state, 1, "a1", 9_000, 5_000, 8_000);
    // One landing in the 10 s window ending at 10_000.
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.window_ms).toBe(10_000);
    expect(metrics.landings_per_second).toBeCloseTo(0.1);
    // 14.2: landed ts 9_000 − submit ts 5_000.
    expect(metrics.time_to_land_ms).toEqual({ p50: 4_000, p99: 4_000 });
  });

  it("14.1: an accepted-but-unpushed landing is not counted", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 1,
          batch_id: 1,
          kind: "change",
          attempt_id: "a1",
          change_id: "c",
          intent_id: "i1",
          request_id: null,
          paths: [],
          writes: [],
        },
        9_000,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.landings_per_second).toBe(0);
  });

  it("14.3 go_around_rate: the share of window landings whose attempt had a repair heads-up", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "attempt.opened",
        { attempt_id: "a2", intent_id: "i1", change_id: "c2", agent: "real", model: "m", race: false },
        0,
      ),
    );
    reduce(
      state,
      ev(
        "headsup.sent",
        {
          attempt_id: "a1",
          hn: 1,
          result: "repair",
          wake: true,
          cause: { type: "landing", seqs: [0], changes: [] },
          keys: [],
          items: [],
          dropped_ops: [],
          go_around: 1,
        },
        4_000,
      ),
    );
    reduce(
      state,
      ev(
        "headsup.resolved",
        { attempt_id: "a1", hn: 1, result: "repair", go_around: 1, changed: true, statement: "s" },
        4_500,
      ),
    );
    landed(state, 1, "a1", 9_000, 5_000, 8_000);
    landed(state, 2, "a2", 9_500, 6_000, 9_100);
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.go_around_rate).toBeCloseTo(0.5);
  });

  it("14.4 false_abort_rate: a go-around counted once when the attempt leaves going_around", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a1",
          from: "working",
          to: "going_around",
          transition: "T8",
          reason: null,
          go_arounds: 1,
          pull_backs: 0,
          right_of_way: false,
        },
        4_000,
      ),
    );
    reduce(
      state,
      ev(
        "headsup.resolved",
        { attempt_id: "a1", hn: 1, result: "repair", go_around: 1, changed: false, statement: "same" },
        5_000,
      ),
    );
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a1",
          from: "going_around",
          to: "submitted",
          transition: "T6",
          reason: null,
          go_arounds: 1,
          pull_backs: 0,
          right_of_way: false,
        },
        6_000,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.false_abort_rate).toBe(1); // resolved with changed: false, ended in the window
    const later = computeMetrics(state, 20_000, 5_000);
    expect(later.false_abort_rate).toBeNull(); // not counted twice (14.4: counted once)
  });

  it("14.5 escape_rate: window landings reverted by a revert landing; null without a green line", () => {
    const state = seeded();
    landed(state, 1, "a1", 5_000, 4_000, 4_500);
    expect(computeMetrics(state, 10_000, 10_000).escape_rate).toBeNull(); // no green line ran yet
    reduce(state, ev("green.advanced", { seq: 1, commit: "gc" }, 5_500));
    reduce(
      state,
      ev(
        "undo.planned",
        { request_id: "r1", cause: "revert", target_seq: 1, reverted: [1], reopened: [], kept_readers: [] },
        6_000,
      ),
    );
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 2,
          batch_id: 2,
          kind: "revert",
          attempt_id: null,
          change_id: "cr",
          intent_id: null,
          request_id: "r1",
          paths: [],
          writes: [],
        },
        6_500,
      ),
    );
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 2, batch_id: 2, commit: "c2", tree: "t2", note: "n", note_json: null, time_to_land_ms: 1 },
        7_000,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.escape_rate).toBe(1); // the one window change was reverted by the green line
  });

  it("14.6 waiting_behind and push_backlog from the attempt states and the pending push", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a1",
          from: "working",
          to: "validated",
          transition: "T7",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        1_000,
      ),
    );
    reduce(state, ev("tick.skipped", { attempt_id: "a1", why: "right_of_way", behind: "a9" }, 2_000));
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 1,
          batch_id: 1,
          kind: "change",
          attempt_id: "a1",
          change_id: "c",
          intent_id: "i1",
          request_id: null,
          paths: [],
          writes: [],
        },
        3_000,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    expect(metrics.waiting_behind).toBe(0); // a1 left validated when it was accepted
    reduce(
      state,
      ev(
        "attempt.opened",
        { attempt_id: "a2", intent_id: "i1", change_id: "c2", agent: "real", model: "m", race: false },
        3_500,
      ),
    );
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a2",
          from: "working",
          to: "validated",
          transition: "T7",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        4_000,
      ),
    );
    reduce(state, ev("tick.skipped", { attempt_id: "a2", why: "right_of_way", behind: "a1" }, 5_000));
    const after = computeMetrics(state, 10_000, 10_000);
    expect(after.waiting_behind).toBe(1);
    expect(after.push_backlog).toBe(1); // a2 in validated while the batch 1 push is pending
  });
});
