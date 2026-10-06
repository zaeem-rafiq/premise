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

// ---- Slice 8 acceptance item 2: every metric of 14 worked by hand from a small fixture ----
// stream built below (BP1). The arithmetic of each expectation is in its comment; nothing is
// read back from the implementation.

function seededSummaryOnly(): FloorState {
  const state = seeded();
  state.pool.summary_only = true; // as created with `summary_only: true` (PL1/EV6)
  return state;
}

function submit(
  state: FloorState,
  attemptId: string,
  status: "validated" | "submitted" | "held" | "accepted" | "landed",
  ts: number,
): void {
  reduce(
    state,
    ev(
      "submit.result",
      { attempt_id: attemptId, submit_id: `s-${ts}`, status, tier: "auto", checks: [], duplicate: false },
      ts,
    ),
  );
}

function headsUpSent(
  state: FloorState,
  attemptId: string,
  hn: number,
  result: "repair" | "confirm" | "info",
  goAround: number | null,
  ts: number,
): void {
  reduce(
    state,
    ev(
      "headsup.sent",
      {
        attempt_id: attemptId,
        hn,
        result,
        wake: true,
        cause: { type: "landing", seqs: [0], changes: [] },
        keys: [],
        items: null, // null in a summary_only pool; the metric must not need it (EV6)
        dropped_ops: [],
        go_around: goAround,
      },
      ts,
    ),
  );
}

function headsUpResolved(
  state: FloorState,
  attemptId: string,
  hn: number,
  result: "repair" | "confirm",
  goAround: number | null,
  changed: boolean,
  ts: number,
): void {
  reduce(
    state,
    ev("headsup.resolved", { attempt_id: attemptId, hn, result, go_around: goAround, changed, statement: "s" }, ts),
  );
}

function attemptState(state: FloorState, attemptId: string, from: string, to: string, ts: number): void {
  reduce(
    state,
    ev(
      "attempt.state",
      {
        attempt_id: attemptId,
        from,
        to,
        transition: "T",
        reason: null,
        go_arounds: to === "going_around" ? 1 : 0,
        pull_backs: 0,
        right_of_way: false,
      },
      ts,
    ),
  );
}

function acceptedAndLanded(
  state: FloorState,
  seq: number,
  attemptId: string,
  tsAccepted: number,
  tsLanded: number,
): void {
  reduce(
    state,
    ev(
      "landing.accepted",
      {
        seq,
        batch_id: seq,
        kind: "change",
        attempt_id: attemptId,
        change_id: `c${seq}`,
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
      { seq, batch_id: seq, commit: `c${seq}`, tree: `t${seq}`, note: "n", note_json: null, time_to_land_ms: null },
      tsLanded,
    ),
  );
}

function openedAttempt(state: FloorState, attemptId: string, agent: "real" | "synthetic", ts: number): void {
  reduce(
    state,
    ev(
      "attempt.opened",
      { attempt_id: attemptId, intent_id: "i1", change_id: `c-${attemptId}`, agent, model: "m", race: false },
      ts,
    ),
  );
}

describe("14.1 landings per second, worked from the definition", () => {
  it("counts the window's landed changes over window seconds; edges and unpushed landings", () => {
    const state = seeded();
    // Window (0, 10_000]: the landing at ts 0 is out (window is open on the left), the two at
    // 4_000 and 9_000 are in, the accepted-but-unpushed one is not a landing.landed at all.
    acceptedAndLanded(state, 1, "a1", 500, 0); // landed exactly at `from` — out
    acceptedAndLanded(state, 2, "a1", 3_000, 4_000);
    acceptedAndLanded(state, 3, "a1", 8_000, 9_000);
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 4,
          batch_id: 4,
          kind: "change",
          attempt_id: "a1",
          change_id: "c4",
          intent_id: "i1",
          request_id: null,
          paths: [],
          writes: [],
        },
        9_500,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Arithmetic: 2 landing.landed of kind change in the window / 10 s = 0.2.
    expect(metrics.landings_per_second).toBeCloseTo(0.2);
  });

  it("counts a landing.landed whose accepted predates the stream (digest row, FE1)", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 7, batch_id: 7, commit: "c7", tree: "t7", note: "n", note_json: null, time_to_land_ms: null },
        9_000,
      ),
    );
    // Arithmetic: the event's ts is in the window — 1 / 10 s = 0.1, digest or not.
    expect(computeMetrics(state, 10_000, 10_000).landings_per_second).toBeCloseTo(0.1);
  });
});

describe("14.2 time to land, worked from the definition", () => {
  it("measures from the last validated/submitted/held submit.result, never a later accepted or landed", () => {
    const state = seeded();
    openedAttempt(state, "a2", "real", 0);
    // a1: submit answered `validated` at 4_000, accepted at 8_000, landed at 9_000 — and Trunk
    // then reports `accepted` and `landed` on submit.result too (LP9). The base stays 4_000:
    // time to land = 9_000 − 4_000 = 5_000 ms.
    submit(state, "a1", "validated", 4_000);
    submit(state, "a2", "held", 5_000); // a2's submit at 5_000 lands at 9_400: 4_400 ms
    submit(state, "a1", "accepted", 8_000);
    acceptedAndLanded(state, 1, "a1", 8_000, 9_000);
    acceptedAndLanded(state, 2, "a2", 9_000, 9_400);
    submit(state, "a1", "landed", 9_500);
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Sorted [5_000, 4_400] → p50 index ceil(0.5·2)−1 = 0 → 4_400; p99 index 1 → 5_000.
    expect(metrics.time_to_land_ms).toEqual({ p50: 4_400, p99: 5_000 });
  });
});

describe("14.3 go-around rate, worked from the definition — receipt counts, not resolution", () => {
  it("counts a sent repair heads-up even unresolved, in a summary_only pool", () => {
    const state = seededSummaryOnly();
    openedAttempt(state, "a2", "synthetic", 0);
    openedAttempt(state, "a3", "synthetic", 0);
    // a1 received TWO repair heads-ups (only the last survives FE4's one-entry memory) and a
    // confirm; a2 received one confirm; a3 none. Landings: a1 and a3 change-land in the window.
    headsUpSent(state, "a1", 1, "repair", 1, 4_000);
    headsUpSent(state, "a1", 2, "repair", 2, 4_100);
    headsUpSent(state, "a1", 3, "confirm", null, 4_200);
    headsUpSent(state, "a2", 1, "confirm", null, 4_300);
    acceptedAndLanded(state, 1, "a1", 5_000, 9_000);
    acceptedAndLanded(state, 2, "a3", 6_000, 9_500);
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Arithmetic: 1 of 2 window landings had ≥1 repair heads-up before acceptance → 1/2.
    expect(metrics.go_around_rate).toBeCloseTo(0.5);
    // The frozen head_counts are the reducer's confirm-rate input (no metrics field, EM5):
    // landing 1 saw 2 repairs + 1 confirm; landing 2 saw neither.
    expect(state.landing_facts[1]).toMatchObject({ repair: 2, confirm: 1 });
    expect(state.landing_facts[2]).toMatchObject({ repair: 0, confirm: 0 });
  });
});

describe("14.4 false-abort rate, worked from the definition — summary_only, no op.recorded", () => {
  it("counts a pair once on leaving going_around; stopped is out; changed false is the abort", () => {
    const state = seededSummaryOnly();
    openedAttempt(state, "a2", "synthetic", 0);
    openedAttempt(state, "a3", "synthetic", 0);
    // a1: go-around pair (a1,1) resolved changed:false at 3_000, leaves going_around at 4_000 →
    // a false abort. a2: resolved changed:true at 3_100, leaves at 4_100 → not. a3: resolved
    // changed:false but leaves for `stopped` at 4_200 → out of the denominator entirely.
    attemptState(state, "a1", "working", "going_around", 2_000);
    attemptState(state, "a2", "working", "going_around", 2_000);
    attemptState(state, "a3", "working", "going_around", 2_000);
    headsUpResolved(state, "a1", 1, "repair", 1, false, 3_000);
    headsUpResolved(state, "a2", 1, "repair", 1, true, 3_100);
    headsUpResolved(state, "a3", 1, "repair", 1, false, 3_200);
    attemptState(state, "a1", "going_around", "validated", 4_000);
    attemptState(state, "a2", "going_around", "working", 4_100);
    attemptState(state, "a3", "going_around", "stopped", 4_200);
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Arithmetic: go-arounds resolved in the window = a1 and a2 (a3 stopped → excluded);
    // false aborts = a1 → 1/2 = 0.5.
    expect(metrics.false_abort_rate).toBe(0.5);
    // A second repair resolution on the same pair with changed:true would have un-aborted it —
    // check the accumulator: another resolved on (a1,1) is recorded under the same entry.
    headsUpResolved(state, "a1", 9, "repair", 1, true, 4_300); // late, same pair
    attemptState(state, "a1", "working", "going_around", 5_000); // a new go-around, pair (a1,2)…
    headsUpResolved(state, "a1", 10, "repair", 2, false, 6_000);
    attemptState(state, "a1", "going_around", "submitted", 7_000);
    const next = computeMetrics(state, 10_000, 10_000);
    // Now resolved in the window: (a1,1) abort — the late changed:true landed AFTER the count,
    // the spec counts at the leaving — (a2,1) not, (a1,2) abort → 2 aborts of 3.
    expect(next.false_abort_rate).toBeCloseTo(2 / 3);
  });
});

describe("14.5 escape rate, worked from the definition", () => {
  it('is null while the stream holds no green-line event (features.green "none" case)', () => {
    const state = seeded();
    acceptedAndLanded(state, 1, "a1", 4_000, 9_000);
    // features.green is not on the stream; a build with green "none" simply emits no green
    // event — the reducer's null answers exactly that case.
    expect(computeMetrics(state, 10_000, 10_000).escape_rate).toBeNull();
  });

  it("counts only undo.planned of cause revert; an owner undo is not an escape", () => {
    const state = seeded();
    openedAttempt(state, "a2", "real", 0);
    acceptedAndLanded(state, 1, "a1", 4_000, 5_000);
    acceptedAndLanded(state, 2, "a2", 4_100, 5_100);
    reduce(state, ev("green.advanced", { seq: 2, commit: "gc" }, 5_500));
    // An owner undo plans with cause "undo" and lands kind "undo" — seq 1 undone_by it.
    reduce(
      state,
      ev(
        "undo.planned",
        { request_id: "ru", cause: "undo", target_seq: 1, reverted: [1], reopened: [], kept_readers: [] },
        6_000,
      ),
    );
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 3,
          batch_id: 3,
          kind: "undo",
          attempt_id: null,
          change_id: "cu",
          intent_id: null,
          request_id: "ru",
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
        { seq: 3, batch_id: 3, commit: "c3", tree: "t3", note: "n", note_json: null, time_to_land_ms: null },
        7_000,
      ),
    );
    // The green line reverts seq 2: undo.planned cause "revert" + kind "revert" landing.
    reduce(
      state,
      ev(
        "undo.planned",
        { request_id: "rr", cause: "revert", target_seq: 2, reverted: [2], reopened: [], kept_readers: [] },
        7_500,
      ),
    );
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 4,
          batch_id: 4,
          kind: "revert",
          attempt_id: null,
          change_id: "cv",
          intent_id: null,
          request_id: "rr",
          paths: [],
          writes: [],
        },
        8_000,
      ),
    );
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 4, batch_id: 4, commit: "c4", tree: "t4", note: "n", note_json: null, time_to_land_ms: null },
        8_500,
      ),
    );
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Arithmetic: window change landings = seq 1 and seq 2 (the undo/revert landings are not
    // kind change). Only seq 2 was reverted by the green line → 1/2 = 0.5.
    expect(metrics.escape_rate).toBe(0.5);
  });

  it("is 0 — not null — when a green line exists and nothing it reverted is in the window", () => {
    const state = seeded();
    reduce(
      state,
      ev(
        "green.verified",
        { seq: 1, commit: "gc", ok: true, runtime: "isolate", checks: [], ms: 10, confirmed: true },
        2_000,
      ),
    );
    acceptedAndLanded(state, 1, "a1", 4_000, 9_000);
    // 1 window landing, 0 reverted → 0.
    expect(computeMetrics(state, 10_000, 10_000).escape_rate).toBe(0);
  });
});

describe("14.6 waiting behind another change, worked from the definition", () => {
  it("counts validated attempts the tick skipped for right_of_way; cards and other reasons are out", () => {
    const state = seeded();
    // a1: validated, skipped right_of_way → counts.
    openedAttempt(state, "a2", "real", 0);
    openedAttempt(state, "a3", "real", 0);
    openedAttempt(state, "a4", "real", 0);
    attemptState(state, "a1", "working", "validated", 1_000);
    reduce(state, ev("tick.skipped", { attempt_id: "a1", why: "right_of_way", behind: "a9" }, 2_000));
    // a2: validated but skipped checks_failed (premises not holding — out).
    attemptState(state, "a2", "working", "validated", 1_000);
    reduce(state, ev("tick.skipped", { attempt_id: "a2", why: "checks_failed", behind: null }, 2_000));
    // a3: validated, skipped not_disjoint (waits on overlapping edits, not right_of_way — out).
    attemptState(state, "a3", "working", "validated", 1_000);
    reduce(state, ev("tick.skipped", { attempt_id: "a3", why: "not_disjoint", behind: "a9" }, 2_000));
    // a4: validated and skipped right_of_way, but it sits on a card — waiting on a person.
    attemptState(state, "a4", "working", "validated", 1_000);
    reduce(
      state,
      ev(
        "card.opened",
        {
          card: {
            card_id: "card1",
            kind: "held",
            attempt_ids: ["a4"],
            intent_ids: ["i1"],
            submit_ids: {},
            title: "t",
            body: [],
            options: [],
            paths: [],
            blast_radius: {},
            preview: null,
            candidates: null,
            risk: null,
            reason: "held_path",
          },
        },
        1_500,
      ),
    );
    reduce(state, ev("tick.skipped", { attempt_id: "a4", why: "right_of_way", behind: "a9" }, 2_000));
    const metrics = computeMetrics(state, 10_000, 10_000);
    // Arithmetic: only a1 counts → 1. (The batch-full half of 14.6 has no carrier on the
    // stream: `tick.skipped.why` has no value for it.)
    expect(metrics.waiting_behind).toBe(1);
  });
});

describe("14.7 repair latency, worked from the definition", () => {
  it("measures real agents only, held counts, and works in a summary_only pool", () => {
    const state = seededSummaryOnly();
    openedAttempt(state, "a2", "synthetic", 0);
    openedAttempt(state, "a3", "real", 0);
    // a1 (real): repair heads-up at 4_000 → first answered submit `validated` at 6_000 → 2_000.
    headsUpSent(state, "a1", 1, "repair", 1, 4_000);
    submit(state, "a1", "validated", 6_000);
    // a2 (synthetic): repair at 4_000, answered at 6_500 — excluded: 14.7 is real agents only.
    headsUpSent(state, "a2", 1, "repair", 1, 4_000);
    submit(state, "a2", "validated", 6_500);
    // a3 (real): repair at 4_000, answered `held` at 7_000 → 3_000 (held ends the clock).
    headsUpSent(state, "a3", 1, "repair", 1, 4_000);
    submit(state, "a3", "held", 7_000);
    // The reducer's ledger (EM5 computes it; the metrics event carries no field):
    // repair_ms = [6_000−4_000, 7_000−4_000] = [2_000, 3_000] → p50 = 2_000, p90 = 3_000.
    expect(state.repair_ms).toEqual([2_000, 3_000]);
  });
});

describe("14.8 fork throughput, worked from the definition", () => {
  it("keeps the attempt.repo ledger: provisioned count, failures, first and last ts", () => {
    const state = seeded();
    reduce(state, ev("attempt.repo", { attempt_id: "a1", ok: true, ms: 120, error: null }, 1_000));
    reduce(state, ev("attempt.repo", { attempt_id: "a2", ok: true, ms: 200, error: null }, 2_000));
    reduce(state, ev("attempt.repo", { attempt_id: "a3", ok: false, ms: 50, error: "io" as never }, 5_000));
    // Arithmetic over the ledger: 3 provisions in the 4 s span 1_000→5_000 → 0.75/s;
    // failure rate = 1/3. The event carries no field (EM5) — the ledger is what the reducer
    // computes from the stream.
    expect(state.repos).toEqual({ ok: 2, failed: 1, first_ts: 1_000, last_ts: 5_000 });
    const span_s = (state.repos.last_ts! - state.repos.first_ts!) / 1_000;
    expect((state.repos.ok + state.repos.failed) / span_s).toBeCloseTo(0.75);
    expect(state.repos.failed / (state.repos.ok + state.repos.failed)).toBeCloseTo(1 / 3);
  });
});
