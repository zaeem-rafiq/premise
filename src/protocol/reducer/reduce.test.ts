// Reducer tests for the event types of 01-core 12.1 (AC2): each `it` names the spec row or rule it
// proves, and the expected state is taken from the mapping table of 03-floor 4.3 and the rules of
// 01-core — never from what the implementation happens to compute (BP1).

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import { EVENT_TYPES } from "../events.ts";
import { FLOOR_KEEP_LANDINGS } from "../constants.ts";
import type { Card } from "../cards.ts";
import type { FloorState, LandingEntry, LandingView } from "./state.ts";
import { emptyFloorState, premiseId } from "./state.ts";
import { HANDLED_TYPES, reduce } from "./reduce.ts";

// One event builder per test file: `n` ticks up per event, `t` is the arrival (unused by the
// reducer), `ts` the source's commit time. Fields come from 12.1.
let n = 0;
function ev(type: PoolEvent["type"], body: object = {}, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
}

/** Record access under noUncheckedIndexedAccess: unwraps or throws. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a defined value");
  return value;
}

function view(entry: LandingEntry | undefined): LandingView {
  if (entry === undefined || entry.digest === true) throw new Error("expected a full LandingView");
  return entry;
}

function baseState(): FloorState {
  const state = emptyFloorState();
  reduce(
    state,
    ev("pool.state", {
      head_seq: 0,
      head_commit: "seed00",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "seed00",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://pool/tidepool",
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
      real_agents: 1,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
    }),
  );
  return state;
}

const ENERGY = "world/energy.js#ENERGY_MAX";

function openAttempt(state: FloorState, attemptId: string, intentId: string, ts = 1_000): void {
  reduce(
    state,
    ev(
      "intent.created",
      { intent_id: intentId, text: `text of ${intentId}`, requester: "owner", race: false, prewritten: false },
      ts,
    ),
  );
  reduce(
    state,
    ev(
      "attempt.opened",
      {
        attempt_id: attemptId,
        intent_id: intentId,
        change_id: `c_${attemptId}`,
        agent: "real",
        model: "m-1",
        race: false,
      },
      ts + 1,
    ),
  );
}

describe("03-floor 4.3: pool rows", () => {
  it("pool.state sets the pool fields of 4.1", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "pool.state",
        {
          head_seq: 3,
          head_commit: "h3",
          green_seq: 2,
          landed_seq: 2,
          landed_commit: "c2",
          state: "rebuilding",
          reason: "x",
          epoch: 1,
          remote: "https://pool/tidepool",
          plain_remote: "https://pool/plain",
          rebuild: { done: 1, total: 5 },
          unwitnessed: [7],
          real_agents: 2,
          max_real_agents: 6,
          synthetic: true,
          summary_only: false,
        },
        1_100,
      ),
    );
    expect(state.pool).toMatchObject({
      state: "rebuilding",
      reason: "x",
      epoch: 1,
      head_seq: 3,
      landed_seq: 2,
      landed_commit: "c2",
      remote: "https://pool/tidepool",
      plain_remote: "https://pool/plain",
      rebuild: { done: 1, total: 5 },
      unwitnessed: [7],
      real_agents: 2,
      max_real_agents: 6,
      synthetic: true,
      summary_only: false,
    });
    expect(state.n).toBe(2);
    expect(state.ts).toBe(1_100);
  });

  it("IR8: pool.state's app is kept as sent — null for an imported pool, tidepool when absent", () => {
    // The defect, seen live on an imported pool: `event.app ?? "tidepool"` turned the imported
    // pool's `app: null` into "tidepool", so the page would draw a live frame it does not have.
    const imported = baseState();
    reduce(imported, ev("pool.state", { state: "ready", reason: null, epoch: 1, head_seq: 0, app: null }));
    expect(imported.pool.app).toBeNull();
    const seeded = baseState();
    reduce(seeded, ev("pool.state", { state: "ready", reason: null, epoch: 1, head_seq: 0, app: "tidepool" }));
    expect(seeded.pool.app).toBe("tidepool");
    // A stream from before IR8 carries no `app`: its pools were all made from seeds.
    expect(baseState().pool.app).toBe("tidepool");
  });

  it("pool.state with a higher epoch closes every open card as stale by system (RB5)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    const card = cardOf("k1", ["a1"]);
    reduce(state, ev("card.opened", { card }, 1_200));
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
          epoch: 2,
          remote: "r",
          plain_remote: null,
          rebuild: null,
          unwitnessed: [],
          real_agents: 1,
          max_real_agents: 6,
          synthetic: false,
          summary_only: false,
        },
        1_300,
      ),
    );
    expect(state.open_cards).toEqual([]);
    expect(must(state.cards.k1).open).toBe(false);
    expect(must(state.cards.k1).closed).toEqual({
      action: "stale",
      by: "system",
      attempt_id: null,
      reason: null,
      ts: 1_300,
    });
  });

  it("pool.state at the same epoch leaves cards open", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(state, ev("card.opened", { card: cardOf("k1", ["a1"]) }, 1_200));
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
        1_300,
      ),
    );
    expect(state.open_cards).toEqual(["k1"]);
    expect(must(state.cards.k1).open).toBe(true);
  });

  it("pool.files sets exists and tier; an unlisted path no longer exists", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "pool.files",
        {
          files: [
            { path: "a.js", tier: "auto" },
            { path: "b.js", tier: "held" },
          ],
        },
        1_100,
      ),
    );
    expect(must(state.files["a.js"])).toMatchObject({ exists: true, tier: "auto" });
    expect(must(state.files["b.js"])).toMatchObject({ exists: true, tier: "held" });
    reduce(state, ev("pool.files", { files: [{ path: "a.js", tier: "held" }] }, 1_200));
    expect(must(state.files["a.js"]).tier).toBe("held");
    expect(must(state.files["b.js"]).exists).toBe(false);
    expect(must(state.files["b.js"]).tier).toBeNull();
  });

  it("pool.paused sets state paused and the reason", () => {
    const state = baseState();
    reduce(state, ev("pool.paused", { reason: "push_rejected", detail: "rejected" }, 1_100));
    expect(state.pool.state).toBe("paused");
    expect(state.pool.reason).toBe("push_rejected");
  });

  it("trunk.error counts the event and nothing else", () => {
    const state = baseState();
    reduce(state, ev("trunk.error", { where: "push", code: "transport" }, 1_100));
    reduce(state, ev("trunk.error", { where: "push", code: "http_503" }, 1_200));
    expect(state.trunk_errors).toBe(2);
  });
});

describe("03-floor 4.3: intents and attempts", () => {
  it("intent.created adds the intent and starts the run clock on the first intent", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "intent.created",
        { intent_id: "i1", text: "a crab", requester: "owner", race: false, prewritten: true },
        2_000,
      ),
    );
    reduce(
      state,
      ev("intent.created", { intent_id: "i2", text: "b", requester: "o", race: true, prewritten: false }, 3_000),
    );
    expect(state.first_intent_ts).toBe(2_000);
    expect(must(state.intents.i1)).toMatchObject({
      text: "a crab",
      race: false,
      prewritten: true,
      state: "open",
      created_ts: 2_000,
    });
    expect(must(state.intents.i2)).toMatchObject({ race: true });
  });

  it("intent.state sets the intent's state", () => {
    const state = baseState();
    reduce(state, ev("intent.created", { intent_id: "i1", text: "a", requester: "o", race: false, prewritten: false }));
    reduce(state, ev("intent.state", { intent_id: "i1", state: "undone" }, 1_100));
    expect(must(state.intents.i1).state).toBe("undone");
  });

  it("attempt.opened adds the attempt, links it to the intent, joins the rail (EM1a)", () => {
    const state = baseState();
    reduce(state, ev("intent.created", { intent_id: "i1", text: "a", requester: "o", race: false, prewritten: false }));
    reduce(
      state,
      ev(
        "attempt.opened",
        { attempt_id: "a1", intent_id: "i1", change_id: "c1", agent: "synthetic", model: null, race: false },
        1_100,
      ),
    );
    const attempt = must(state.attempts.a1);
    expect(attempt).toMatchObject({ state: "opened", agent: "synthetic", intent_id: "i1", change_id: "c1" });
    expect(must(state.intents.i1).attempt_ids).toEqual(["a1"]);
    expect(state.working_order).toEqual(["a1"]);
    expect(state.pool.synthetic).toBe(true); // EM1a: the SYNTHETIC banner flag only ever rises
  });

  it("attempt.state sets the state fields, the stop reason on stopped, and clears skipped", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(state, ev("tick.skipped", { attempt_id: "a1", why: "right_of_way", behind: "a9" }, 1_200));
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
        1_300,
      ),
    );
    const attempt = must(state.attempts.a1);
    expect(attempt).toMatchObject({
      state: "going_around",
      go_arounds: 1,
      pull_backs: 0,
      right_of_way: false,
      skipped: null,
    });
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a1",
          from: "going_around",
          to: "stopped",
          transition: "T17",
          reason: "go_around_limit",
          go_arounds: 1,
          pull_backs: 0,
          right_of_way: false,
        },
        1_400,
      ),
    );
    expect(must(state.attempts.a1).stop_reason).toBe("go_around_limit");
    expect(state.working_order).not.toContain("a1"); // stopped moves to the Stopped tab
  });

  it("attempt.state counts a go-around only when one starts (GA1: T10a/T21 yes, T10 no)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    // T10a: a new go-around while going_around — same state, higher count.
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "working",
        to: "going_around",
        transition: "T8",
        reason: null,
        go_arounds: 1,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    expect(state.counters.go_arounds).toBe(1);
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "going_around",
        to: "going_around",
        transition: "T10a",
        reason: null,
        go_arounds: 2,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    expect(state.counters.go_arounds).toBe(2);
    // T10: a repair joins the open go-around — same count, no new go-around.
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "going_around",
        to: "going_around",
        transition: "T10",
        reason: null,
        go_arounds: 2,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    expect(state.counters.go_arounds).toBe(2);
    // T21: "Try again" from stopped resets the count and starts one.
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "going_around",
        to: "stopped",
        transition: "T17",
        reason: "cancelled",
        go_arounds: 2,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "stopped",
        to: "going_around",
        transition: "T21",
        reason: null,
        go_arounds: 1,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    expect(state.counters.go_arounds).toBe(3);
  });

  it("attempt.reopened sets revision, cause and model flag; undo reloads premises and clears landed_seq", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 1,
          batch_id: 1,
          kind: "change",
          attempt_id: "a1",
          change_id: "c_a1",
          intent_id: "i1",
          request_id: null,
          paths: ["world/energy.js"],
          writes: [],
        },
        1_200,
      ),
    );
    expect(must(state.attempts.a1).landed_seq).toBe(1);
    reduce(state, ev("attempt.reopened", { attempt_id: "a1", cause: "undo", revision: 2, model_changed: true }, 1_300));
    const attempt = must(state.attempts.a1);
    expect(attempt.revision).toBe(2);
    expect(attempt.reopened_by).toBe("undo");
    expect(attempt.model_changed).toBe(true);
    expect(attempt.landed_seq).toBeNull();
    const premise = must(attempt.premises[premiseId("entity", ENERGY)]);
    expect(premise).toBeDefined();
    expect(premise.light).toBe("holds"); // all lights are holds until judged
    expect(premise.judgment).toBeNull();
    expect(state.working_order).toContain("a1");
  });

  it("attempt.step sets step, steps, last_event_ts and adds cost_usd", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "attempt.step",
        {
          attempt_id: "a1",
          step: 1,
          tool: "read",
          target: "w.js",
          ok: true,
          error: null,
          ms: 5,
          tokens_in: null,
          tokens_out: null,
          cost_usd: null,
        },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "attempt.step",
        {
          attempt_id: "a1",
          step: 2,
          tool: null,
          target: null,
          ok: true,
          error: null,
          ms: 9,
          tokens_in: 3,
          tokens_out: 4,
          cost_usd: 0.01,
        },
        1_200,
      ),
    );
    reduce(
      state,
      ev(
        "attempt.step",
        {
          attempt_id: "a1",
          step: 3,
          tool: null,
          target: null,
          ok: true,
          error: null,
          ms: 9,
          tokens_in: 3,
          tokens_out: 4,
          cost_usd: 0.02,
        },
        1_300,
      ),
    );
    const attempt = must(state.attempts.a1);
    expect(attempt.step).toMatchObject({ n: 3, tool: null, ok: true, ts: 1_300 });
    expect(attempt.steps).toBe(3);
    expect(attempt.last_event_ts).toBe(1_300);
    expect(attempt.cost_usd).toBeCloseTo(0.03);
  });

  it("attempt.repo counts ok and failed and keeps first and last ts (14.8)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(state, ev("attempt.repo", { attempt_id: "a1", ok: true, ms: 100, error: null }, 1_100));
    reduce(state, ev("attempt.repo", { attempt_id: "a1", ok: false, ms: 50, error: "timeout" }, 1_300));
    expect(state.repos).toEqual({ ok: 1, failed: 1, first_ts: 1_100, last_ts: 1_300 });
  });
});

describe("03-floor 4.3: premises, operations, heads-ups", () => {
  it("premise.recorded adds a premise with light holds and marks the reader", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_100,
      ),
    );
    const premise = must(state.attempts.a1).premises[premiseId("entity", ENERGY)];
    expect(premise).toMatchObject({
      kind: "entity",
      key: ENERGY,
      read: true,
      edit: false,
      derived: false,
      light: "holds",
      judgment: null,
    });
    expect(must(state.files["world/energy.js"]).readers).toEqual(["a1"]);
    expect(must(state.files["world/energy.js"]).keys).toEqual([ENERGY]);
  });

  it("premise.recorded on a listing key marks the directory reader", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "list",
          premise: { kind: "listing", key: "creatures/", hash: "l0", seq: 0, read: true, edit: false, derived: false },
        },
        1_100,
      ),
    );
    expect(must(state.dirs["creatures/"]).readers).toEqual(["a1"]);
  });

  it("premise.removed removes the premise and its reader mark", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "list",
          premise: { kind: "listing", key: "creatures/", hash: "l0", seq: 0, read: true, edit: false, derived: false },
        },
        1_100,
      ),
    );
    reduce(state, ev("premise.removed", { attempt_id: "a1", kind: "listing", key: "creatures/", rule: "L2" }, 1_200));
    expect(must(state.attempts.a1).premises[premiseId("listing", "creatures/")]).toBeUndefined();
    expect(must(state.dirs["creatures/"]).readers).toEqual([]);
  });

  it("premise.judged maps result to the light of 4.3 (repair, confirm, B1, triage, holds)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    const recorded = {
      kind: "entity" as const,
      key: ENERGY,
      hash: "h0",
      seq: 0,
      read: true,
      edit: false,
      derived: false,
    };
    reduce(state, ev("premise.recorded", { attempt_id: "a1", tool: "read", premise: recorded }, 1_100));
    const id = premiseId("entity", ENERGY);
    const judge = (result: "holds" | "confirm" | "repair" | null, rule: string, ts: number) =>
      reduce(
        state,
        ev(
          "premise.judged",
          {
            attempt_id: "a1",
            kind: "entity",
            key: ENERGY,
            old_hash: "h0",
            new_hash: "h1",
            cause: "landing",
            cause_seq: 1,
            rule,
            class: "rule",
            result,
            reason: "r",
            clef: null,
          },
          ts,
        ),
      );
    judge("repair", "E2", 1_200);
    expect(must(must(state.attempts.a1).premises[id]).light).toBe("changed");
    judge("confirm", "B1", 1_300);
    expect(must(must(state.attempts.a1).premises[id]).light).toBe("blind_spot");
    judge("confirm", "E2m", 1_400);
    expect(must(must(state.attempts.a1).premises[id]).light).toBe("confirm");
    judge(null, "E3", 1_500);
    expect(must(must(state.attempts.a1).premises[id]).light).toBe("checking");
    judge("holds", "E2", 1_600);
    expect(must(must(state.attempts.a1).premises[id]).light).toBe("holds");
    expect(must(must(state.attempts.a1).premises[id]).judgment).toMatchObject({
      rule: "E2",
      result: "holds",
      cause_seq: 1,
    });
  });

  it("op.recorded appends the operation, marks the writer and the entity keys", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "op.recorded",
        {
          attempt_id: "a1",
          op_seq: 1,
          op: "replace",
          path: "world/energy.js",
          targets: [ENERGY],
          altered: [ENERGY],
          added: [],
          removed: [],
        },
        1_100,
      ),
    );
    const attempt = must(state.attempts.a1);
    expect(attempt.ops).toHaveLength(1);
    expect(must(attempt.ops)[0]).toMatchObject({ op_seq: 1, op: "replace", path: "world/energy.js", dropped: false });
    expect(must(state.files["world/energy.js"]).writers).toEqual(["a1"]);
    expect(must(state.files["world/energy.js"]).keys).toContain(ENERGY);
  });

  it("op.dropped marks the listed operations and lifts the writer mark when none remain", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "op.recorded",
        {
          attempt_id: "a1",
          op_seq: 1,
          op: "replace",
          path: "world/energy.js",
          targets: [],
          altered: [],
          added: [],
          removed: [],
        },
        1_100,
      ),
    );
    reduce(state, ev("op.dropped", { attempt_id: "a1", op_seqs: [1], path: "world/energy.js", rule: "OP1" }, 1_200));
    expect(must(must(state.attempts.a1).ops[0]).dropped).toBe(true);
    expect(must(state.files["world/energy.js"]).writers).toEqual([]);
  });

  it("headsup.sent stores the view, sets item lights, and opens the repair clock for real attempts", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_050,
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
          cause: { type: "landing", seqs: [1], changes: [{ seq: 1, change_id: "c9", intent_text: "energy" }] },
          keys: [{ kind: "entity", key: ENERGY, rule: "E2" }],
          items: [
            {
              premise: { kind: "entity", key: ENERGY },
              rule: "E2",
              result: "repair",
              reason: "changed",
              old_hash: "h0",
              new_hash: "h1",
              cause_seq: 1,
              diff: { kind: "entity", before: "100", after: "1" },
              uses: [],
            },
          ],
          dropped_ops: [],
          go_around: 1,
        },
        1_100,
      ),
    );
    const headsUp = must(must(state.attempts.a1).heads_ups[1]);
    expect(headsUp).toMatchObject({ hn: 1, result: "repair", wake: true, ts: 1_100, go_around: 1, resolved: null });
    expect(must(must(state.attempts.a1).premises[premiseId("entity", ENERGY)]).light).toBe("changed");
    expect(must(state.attempts.a1).repair_open_ts).toBe(1_100); // 14.7, real attempts only
  });

  it("headsup.resolved sets resolved and returns warning lights to holds; checking stays", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_000,
      ),
    );
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: "w/x.js#X", hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_001,
      ),
    );
    reduce(
      state,
      ev(
        "premise.judged",
        {
          attempt_id: "a1",
          kind: "entity",
          key: "w/x.js#X",
          old_hash: "h",
          new_hash: "h",
          cause: "landing",
          cause_seq: null,
          rule: "E3",
          class: "triage",
          result: null,
          reason: "r",
          clef: null,
        },
        1_002,
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
          cause: { type: "landing", seqs: [1], changes: [] },
          keys: [
            { kind: "entity", key: ENERGY, rule: "E2" },
            { kind: "entity", key: "w/x.js#X", rule: "E3" },
          ],
          items: [
            {
              premise: { kind: "entity", key: ENERGY },
              rule: "E2",
              result: "repair",
              reason: "r",
              old_hash: "h0",
              new_hash: "h1",
              cause_seq: 1,
              diff: { kind: "entity", before: "a", after: "b" },
              uses: [],
            },
            {
              premise: { kind: "entity", key: "w/x.js#X" },
              rule: "E3",
              result: "pending",
              reason: "r",
              old_hash: "h",
              new_hash: "h",
              cause_seq: 1,
              diff: { kind: "entity", before: null, after: null },
              uses: [],
            },
          ],
          dropped_ops: [],
          go_around: 1,
        },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "headsup.resolved",
        { attempt_id: "a1", hn: 1, result: "repair", go_around: 1, changed: true, statement: "fixed it" },
        1_200,
      ),
    );
    const headsUp = must(must(state.attempts.a1).heads_ups[1]);
    expect(headsUp.resolved).toEqual({ statement: "fixed it", changed: true, ts: 1_200 });
    expect(must(must(state.attempts.a1).premises[premiseId("entity", ENERGY)]).light).toBe("holds");
    expect(must(must(state.attempts.a1).premises[premiseId("entity", "w/x.js#X")]).light).toBe("checking"); // a checking light stays
  });

  it("submit.result sets the submit, ignores duplicates, and ends the repair clock (14.7)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "headsup.sent",
        {
          attempt_id: "a1",
          hn: 1,
          result: "repair",
          wake: true,
          cause: { type: "landing", seqs: [1], changes: [] },
          keys: [],
          items: [],
          dropped_ops: [],
          go_around: 1,
        },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "submit.result",
        { attempt_id: "a1", submit_id: "s1", status: "validated", tier: "auto", checks: [], duplicate: false },
        1_600,
      ),
    );
    expect(must(state.attempts.a1).submit).toMatchObject({
      submit_id: "s1",
      status: "validated",
      tier: "auto",
      ts: 1_600,
    });
    expect(state.repair_ms).toEqual([500]);
    expect(must(state.attempts.a1).repair_open_ts).toBeNull();
    reduce(
      state,
      ev(
        "submit.result",
        { attempt_id: "a1", submit_id: "s1", status: "validated", tier: "auto", checks: [], duplicate: true },
        1_700,
      ),
    );
    expect(must(must(state.attempts.a1).submit).ts).toBe(1_600); // the duplicate was ignored
  });
});

function cardOf(cardId: string, attemptIds: string[]): Card {
  return {
    card_id: cardId,
    kind: "held",
    attempt_ids: attemptIds,
    intent_ids: [],
    submit_ids: {},
    title: "t",
    body: [],
    options: [
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ],
    paths: [],
    blast_radius: {},
    preview: null,
    candidates: null,
    risk: null,
    reason: "held_path",
  };
}

describe("03-floor 4.3: cards", () => {
  it("card.opened adds the card, joins open_cards oldest first, sets card_id on its attempts", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(state, ev("card.opened", { card: cardOf("k1", ["a1"]) }, 1_100));
    reduce(state, ev("card.opened", { card: cardOf("k2", ["a1"]) }, 1_200));
    expect(state.open_cards).toEqual(["k1", "k2"]);
    expect(must(state.cards.k1).open).toBe(true);
    expect(must(state.attempts.a1).card_id).toBe("k2");
  });

  it("card.updated replaces the Card in place", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(state, ev("card.opened", { card: cardOf("k1", ["a1"]) }, 1_100));
    const updated = { ...cardOf("k1", ["a1"]), title: "new title" };
    reduce(state, ev("card.updated", { card: updated }, 1_200));
    expect(must(state.cards.k1).card.title).toBe("new title");
    expect(must(state.cards.k1).open).toBe(true);
  });

  it("card.closed removes the card and sets approved_ts on land, land_now and choose", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    openAttempt(state, "a2", "i2");
    reduce(state, ev("card.opened", { card: cardOf("k1", ["a1"]) }, 1_100));
    reduce(
      state,
      ev("card.closed", { card_id: "k1", action: "land", by: "owner", attempt_id: null, reason: null }, 1_200),
    );
    expect(must(state.cards.k1).open).toBe(false);
    expect(state.open_cards).toEqual([]);
    expect(must(state.attempts.a1).approved_ts).toBe(1_200);
    // choose sets it on the named candidate.
    const raceCard = { ...cardOf("k2", ["a1", "a2"]), kind: "race" as const };
    reduce(state, ev("card.opened", { card: raceCard }, 1_300));
    reduce(
      state,
      ev("card.closed", { card_id: "k2", action: "choose", by: "owner", attempt_id: "a2", reason: null }, 1_400),
    );
    expect(must(state.attempts.a2).approved_ts).toBe(1_400);
  });
});

describe("03-floor 4.3: landings, push, undo", () => {
  function accepted(
    state: FloorState,
    seq: number,
    attemptId: string,
    ts: number,
    kind: "change" | "undo" | "revert" = "change",
    requestId: string | null = null,
  ): void {
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq,
          batch_id: seq,
          kind,
          attempt_id: attemptId,
          change_id: "c_" + attemptId,
          intent_id: "i1",
          request_id: requestId,
          paths: ["world/energy.js"],
          writes: [{ kind: "entity", key: ENERGY, old: "h0", new: `h${seq}` }],
        },
        ts,
      ),
    );
  }

  it("landing.accepted freezes the attempt into a LandingView, sets head_seq and starts push", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        },
        1_000,
      ),
    );
    accepted(state, 1, "a1", 1_100);
    const landing = must(state.landings[1]);
    expect(landing).toMatchObject({
      seq: 1,
      kind: "change",
      attempt_id: "a1",
      batch_id: 1,
      accepted_ts: 1_100,
      landed: null,
    });
    if (landing.digest === true) throw new Error("full view expected");
    expect(landing.premises.map((premise) => premise.key)).toEqual([ENERGY]);
    expect(landing.tier).toBeNull();
    expect(state.pool.head_seq).toBe(1);
    expect(state.landed_order).toEqual([1]);
    expect(must(state.attempts.a1).landed_seq).toBe(1);
    expect(state.push).toMatchObject({ batch_id: 1, first_accepted_ts: 1_100, tries: 0 });
  });

  it("landing.landed sets the commit, parses note_json, moves pool.landed_seq and marks the files (FS2)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    accepted(state, 1, "a1", 1_100);
    const noteJson = JSON.stringify({ v: 1, seq: 1, kind: "change" });
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 1, batch_id: 1, commit: "abc", tree: "tr", note: "nid", note_json: noteJson, time_to_land_ms: 400 },
        1_300,
      ),
    );
    const landing = must(state.landings[1]);
    if (landing.digest === true) throw new Error("full view expected");
    expect(landing.landed).toMatchObject({
      commit: "abc",
      tree: "tr",
      note_id: "nid",
      ts: 1_300,
      time_to_land_ms: 400,
    });
    expect(landing.note).toMatchObject({ seq: 1, kind: "change" });
    expect(state.pool.landed_seq).toBe(1);
    expect(state.pool.landed_commit).toBe("abc");
    expect(state.counters.landed_changes).toBe(1);
    // FS2: the seq of the last confirmed landing that changed each path.
    expect(must(state.files["world/energy.js"]).last_landed_seq).toBe(1);
    expect(state.working_order).not.toContain("a1"); // CO12: the card moved to the Landed tab
  });

  it("a landing of kind undo or revert sets undone_by on the reverted and landing_seq on the undo entry (EM4)", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    accepted(state, 1, "a1", 1_000);
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 1, batch_id: 1, commit: "c1", tree: "t1", note: "n1", note_json: null, time_to_land_ms: 1 },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "undo.planned",
        { request_id: "r1", cause: "undo", target_seq: 1, reverted: [1], reopened: ["a1"], kept_readers: [] },
        1_200,
      ),
    );
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 2,
          batch_id: 2,
          kind: "undo",
          attempt_id: null,
          change_id: "cu",
          intent_id: null,
          request_id: "r1",
          paths: [],
          writes: [],
        },
        1_300,
      ),
    );
    reduce(
      state,
      ev(
        "landing.landed",
        { seq: 2, batch_id: 2, commit: "c2", tree: "t2", note: "n2", note_json: null, time_to_land_ms: 1 },
        1_400,
      ),
    );
    expect(must(state.undo.r1).landing_seq).toBe(2);
    expect(must(state.landings[1]).undone_by).toBe(2);
    expect(state.counters.landed_changes).toBe(1); // only the change counted
  });

  it("batch.pushed clears push and sets last_push; push.retry updates the pending push", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    accepted(state, 1, "a1", 1_000);
    reduce(state, ev("push.retry", { batch_id: 1, tries: 2, error: "http_503", next_try_ms: 500 }, 1_100));
    expect(state.push).toMatchObject({ tries: 2, error: "http_503", next_try_ts: 1_600 });
    reduce(
      state,
      ev("batch.pushed", { batch_id: 1, first_seq: 1, last_seq: 1, main: "c1", notes: "n1", tries: 2, ms: 700 }, 1_700),
    );
    expect(state.push).toBeNull();
    expect(state.last_push).toEqual({ batch_id: 1, landings: 1, tries: 2, ms: 700 });
  });

  it("undo.planned adds the undo entry under its request_id; undo.refused changes nothing else", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "undo.planned",
        { request_id: "r1", cause: "revert", target_seq: 1, reverted: [1, 2], reopened: [], kept_readers: [3] },
        1_100,
      ),
    );
    expect(must(state.undo.r1)).toMatchObject({
      cause: "revert",
      target_seq: 1,
      reverted: [1, 2],
      kept_readers: [3],
      landing_seq: null,
    });
    const before = JSON.stringify(state);
    reduce(state, ev("undo.refused", { request_id: "r2", target_seq: 1, reason: "too_old" }, 1_200));
    expect(JSON.stringify(state)).toBe(JSON.stringify({ ...JSON.parse(before), n: state.n, ts: state.ts }));
  });

  it("FS1: past FLOOR_KEEP_LANDINGS landings the oldest is kept as a digest line", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    for (let seq = 1; seq <= FLOOR_KEEP_LANDINGS + 2; seq += 1) {
      reduce(
        state,
        ev(
          "landing.accepted",
          {
            seq,
            batch_id: seq,
            kind: "change",
            attempt_id: "a1",
            change_id: "c",
            intent_id: "i1",
            request_id: null,
            paths: [`p${seq}.js`],
            writes: [],
          },
          1_000 + seq,
        ),
      );
    }
    const full = Object.values(state.landings).filter((entry) => entry.digest !== true);
    expect(full).toHaveLength(FLOOR_KEEP_LANDINGS);
    const oldest = must(state.landings[1]);
    expect(oldest.digest).toBe(true);
    expect(oldest).toMatchObject({ seq: 1, kind: "change", attempt_id: "a1", paths: ["p1.js"] });
    expect(state.landed_order[0]).toBe(FLOOR_KEEP_LANDINGS + 2);
    expect(state.landed_order).toHaveLength(FLOOR_KEEP_LANDINGS + 2);
  });
});

describe("03-floor 4.3: plain, green, metrics, limits, swarm", () => {
  it("plain.updated sets the plain-merge state", () => {
    const state = baseState();
    reduce(
      state,
      ev("plain.updated", { commit: "pc", tree: "pt", through_seq: 4, skipped: [2], interrupted: [3] }, 1_100),
    );
    expect(state.plain).toEqual({ commit: "pc", tree: "pt", through_seq: 4, skipped: [2], interrupted: [3] });
  });

  it("green.verified sets runtime and the failed checks with codes; green.advanced sets seq and commit", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "green.verified",
        {
          seq: 3,
          commit: "gc",
          ok: false,
          runtime: "static",
          checks: [
            { name: "parse", ok: true },
            { name: "imports_resolve", ok: false, code: "imports_resolve:failed" },
          ],
          ms: 1,
          confirmed: true,
        },
        1_100,
      ),
    );
    expect(state.green.runtime).toBe("static");
    expect(state.green.last).toEqual({
      seq: 3,
      ok: false,
      confirmed: true,
      failed: [{ name: "imports_resolve", code: "imports_resolve:failed" }],
    });
    reduce(state, ev("green.advanced", { seq: 3, commit: "gc" }, 1_200));
    expect(state.green.seq).toBe(3);
    expect(state.green.commit).toBe("gc");
  });

  it("metrics stores the newest event and trims metrics_history to the last 60 s", () => {
    const state = baseState();
    const metrics = (ts: number) =>
      reduce(
        state,
        ev(
          "metrics",
          {
            window_ms: 10_000,
            landings_per_second: ts / 1000,
            time_to_land_ms: { p50: null, p99: null },
            time_held_ms: { p50: null, p99: null },
            go_around_rate: null,
            false_abort_rate: null,
            escape_rate: null,
            waiting_behind: 0,
            push_backlog: 0,
            tick_cpu_ms: { p50: null, p99: null },
          },
          ts,
        ),
      );
    metrics(1_000);
    metrics(70_000);
    expect(state.metrics?.ts).toBe(70_000);
    expect(state.metrics_history).toHaveLength(1); // the 1 s entry is out of the 60 s window
    expect(must(state.metrics_history[0]).ts).toBe(70_000);
  });

  it("limits stores the event fields with the event's ts", () => {
    const state = baseState();
    reduce(
      state,
      ev(
        "limits",
        {
          spend_usd: 1.5,
          reserved_usd: 0.5,
          cap_usd: 40,
          killed: false,
          refusing: true,
          models: [{ model: "m", per_minute: 10, used_last_minute: 3 }],
        },
        1_100,
      ),
    );
    expect(state.limits).toEqual({
      spend_usd: 1.5,
      reserved_usd: 0.5,
      cap_usd: 40,
      killed: false,
      refusing: true,
      ts: 1_100,
      models: [{ model: "m", per_minute: 10, used_last_minute: 3 }],
    });
  });

  it("swarm.state sets the swarm and keeps ever_ran once running was true", () => {
    const state = baseState();
    reduce(
      state,
      ev("swarm.state", { synthetic: true, running: true, agents: 4, collision_dial: 0.5, pools: ["tidepool"] }, 1_100),
    );
    expect(state.swarm).toMatchObject({ running: true, agents: 4, ever_ran: true });
    reduce(
      state,
      ev("swarm.state", { synthetic: true, running: false, agents: 0, collision_dial: 0.5, pools: [] }, 1_200),
    );
    expect(state.swarm).toMatchObject({ running: false, ever_ran: true });
  });
});

describe("CO9: the rail order of the Working tab", () => {
  it("newest intent first in the rest group; going_around joins the top group in entry order", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1", 1_000); // oldest intent first
    openAttempt(state, "a2", "i2", 1_100);
    expect(state.working_order).toEqual(["a2", "a1"]);
    // a1 enters going_around: it moves to the top group.
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
        1_200,
      ),
    );
    expect(state.working_order).toEqual(["a1", "a2"]);
    // a2 enters needs_confirm after: it joins the top group behind a1.
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a2",
          from: "working",
          to: "needs_confirm",
          transition: "T11",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        1_300,
      ),
    );
    expect(state.working_order).toEqual(["a1", "a2"]);
    // a1 leaves the top group: it returns to its intent's place, the rest is newest intent first.
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
        1_400,
      ),
    );
    expect(state.working_order).toEqual(["a2", "a1"]);
  });

  it("a race intent moves as one group while any of its attempts is in the top group", () => {
    const state = baseState();
    reduce(
      state,
      ev("intent.created", { intent_id: "iR", text: "race", requester: "o", race: true, prewritten: false }, 900),
    );
    reduce(
      state,
      ev(
        "attempt.opened",
        { attempt_id: "r1", intent_id: "iR", change_id: "c1", agent: "real", model: "m1", race: true },
        901,
      ),
    );
    reduce(
      state,
      ev(
        "attempt.opened",
        { attempt_id: "r2", intent_id: "iR", change_id: "c2", agent: "real", model: "m2", race: true },
        902,
      ),
    );
    openAttempt(state, "a1", "i1", 950);
    expect(state.working_order).toEqual(["a1", "r1", "r2"]); // the older race group follows the newer intent
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "r2",
          from: "working",
          to: "needs_confirm",
          transition: "T11",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        1_000,
      ),
    );
    // The whole race group is in the top group while r2 is.
    expect(state.working_order).toEqual(["r1", "r2", "a1"]);
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "r2",
          from: "needs_confirm",
          to: "working",
          transition: "T14",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        1_100,
      ),
    );
    expect(state.working_order).toEqual(["a1", "r1", "r2"]);
  });
});

describe("FE1 and FE4", () => {
  it("FE1: an event of unknown type changes only n, ts and unknown_events", () => {
    const state = baseState();
    const before = JSON.parse(JSON.stringify(state)) as FloorState;
    const event = { n: 99, t: 5_000, ts: 5_000, pool: "tidepool", src: "trunk", type: "pool.future" } as PoolEvent;
    reduce(state, event);
    expect(state.n).toBe(99);
    expect(state.ts).toBe(5_000);
    expect(state.unknown_events).toBe(before.unknown_events + 1);
    const { n: _n, ts: _ts, unknown_events: _u, ...rest } = state;
    const { n: _bn, ts: _bts, unknown_events: _bu, ...brest } = before;
    expect(rest).toEqual(brest);
  });

  it("FE4: a summary_only pool keeps no steps, premises, operations or items; the rest works", () => {
    const state = emptyFloorState();
    reduce(
      state,
      ev("pool.state", {
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
        real_agents: 200,
        max_real_agents: 6,
        synthetic: true,
        summary_only: true,
      }),
    );
    reduce(
      state,
      ev("intent.created", { intent_id: "i1", text: "x", requester: "swarm", race: false, prewritten: true }),
    );
    reduce(
      state,
      ev("attempt.opened", {
        attempt_id: "a1",
        intent_id: "i1",
        change_id: "c1",
        agent: "synthetic",
        model: null,
        race: false,
      }),
    );
    reduce(
      state,
      ev("attempt.step", {
        attempt_id: "a1",
        step: 1,
        tool: "read",
        target: "f.js",
        ok: true,
        error: null,
        ms: 1,
        tokens_in: null,
        tokens_out: null,
        cost_usd: 0.1,
      }),
    );
    reduce(
      state,
      ev("premise.recorded", {
        attempt_id: "a1",
        tool: "read",
        premise: { kind: "file", key: "f.js", hash: "h", seq: 0, read: true, edit: false, derived: false },
      }),
    );
    reduce(
      state,
      ev("op.recorded", {
        attempt_id: "a1",
        op_seq: 1,
        op: "write",
        path: "f.js",
        targets: [],
        altered: [],
        added: [],
        removed: [],
      }),
    );
    reduce(
      state,
      ev("premise.judged", {
        attempt_id: "a1",
        kind: "file",
        key: "f.js",
        old_hash: "h",
        new_hash: "h",
        cause: "x",
        cause_seq: null,
        rule: "E2",
        class: "rule",
        result: "holds",
        reason: "r",
        clef: null,
      }),
    );
    const attempt = must(state.attempts.a1);
    expect(attempt.step).toBeNull();
    expect(attempt.steps).toBe(0);
    expect(attempt.cost_usd).toBeNull();
    expect(attempt.premises).toEqual({});
    expect(attempt.ops).toEqual([]);
    // The wall fields still work.
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a1",
        from: "opened",
        to: "working",
        transition: "T1",
        reason: null,
        go_arounds: 0,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    expect(attempt.state).toBe("working");
    // Its last heads-up is kept, without items.
    reduce(
      state,
      ev(
        "headsup.sent",
        {
          attempt_id: "a1",
          hn: 2,
          result: "info",
          wake: false,
          cause: { type: "landing", seqs: [1], changes: [] },
          keys: [],
          items: null,
          dropped_ops: [],
          go_around: null,
        },
        1_100,
      ),
    );
    reduce(
      state,
      ev(
        "headsup.sent",
        {
          attempt_id: "a1",
          hn: 3,
          result: "info",
          wake: false,
          cause: { type: "landing", seqs: [2], changes: [] },
          keys: [],
          items: null,
          dropped_ops: [],
          go_around: null,
        },
        1_200,
      ),
    );
    expect(Object.keys(attempt.heads_ups)).toEqual(["3"]);
    expect(must(attempt.heads_ups[3]).items).toBeNull();
  });

  it("FE4: a premise.judged with holds in a summary_only pool changes nothing beyond n and ts", () => {
    const state = emptyFloorState();
    reduce(
      state,
      ev("pool.state", {
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
        real_agents: 0,
        max_real_agents: 6,
        synthetic: false,
        summary_only: true,
      }),
    );
    reduce(
      state,
      ev("attempt.opened", {
        attempt_id: "a1",
        intent_id: "i1",
        change_id: "c1",
        agent: "synthetic",
        model: null,
        race: false,
      }),
    );
    const before = JSON.stringify(must(state.attempts.a1));
    reduce(
      state,
      ev("premise.judged", {
        attempt_id: "a1",
        kind: "file",
        key: "f.js",
        old_hash: "h",
        new_hash: "h",
        cause: "x",
        cause_seq: null,
        rule: "E2",
        class: "rule",
        result: "holds",
        reason: "r",
        clef: null,
      }),
    );
    expect(JSON.stringify(must(state.attempts.a1))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC2: the 35 event types of 03-floor 4.3, each with a reducer test whose expected state is
// written from the 4.3 row — never from the reducer's output.
// ---------------------------------------------------------------------------

describe("AC2: every event type of 03-floor 4.3 has a spec-derived reducer test", () => {
  // The event types of 03-floor 4.3, in the table's order (01-core 12.1 carries the same 35).
  const FLOOR_43 = [
    "pool.state",
    "pool.files",
    "pool.paused",
    "trunk.error",
    "intent.created",
    "intent.state",
    "attempt.opened",
    "attempt.state",
    "attempt.reopened",
    "attempt.step",
    "attempt.repo",
    "premise.recorded",
    "premise.removed",
    "premise.judged",
    "op.recorded",
    "op.dropped",
    "headsup.sent",
    "headsup.resolved",
    "submit.result",
    "card.opened",
    "card.updated",
    "card.closed",
    "landing.accepted",
    "landing.landed",
    "batch.pushed",
    "push.retry",
    "tick.skipped",
    "undo.planned",
    "undo.refused",
    "plain.updated",
    "green.verified",
    "green.advanced",
    "metrics",
    "limits",
    "swarm.state",
  ] as const;

  it("the table lists exactly the 35 types the stream may carry", () => {
    expect(FLOOR_43).toHaveLength(35);
    expect([...FLOOR_43].sort()).toEqual([...EVENT_TYPES].sort());
    expect(HANDLED_TYPES).toEqual(EVENT_TYPES);
  });

  /** A pool with attempt a1 in `working`, holding one entity premise — the base for most rows. */
  function world(ts = 1_000): FloorState {
    const state = baseState();
    openAttempt(state, "a1", "i1", ts);
    reduce(
      state,
      ev(
        "attempt.state",
        {
          attempt_id: "a1",
          from: "opened",
          to: "working",
          transition: "T1",
          reason: null,
          go_arounds: 0,
          pull_backs: 0,
          right_of_way: false,
        },
        ts + 2,
      ),
    );
    reduce(
      state,
      ev(
        "premise.recorded",
        {
          attempt_id: "a1",
          tool: "read",
          premise: { kind: "entity", key: ENERGY, hash: "h-0", seq: 0, read: true, edit: false, derived: false },
        },
        ts + 3,
      ),
    );
    return state;
  }

  const headsUp = (ts: number): Record<string, unknown> => ({
    attempt_id: "a1",
    hn: 1,
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [1], changes: [{ seq: 1, change_id: "c-x", intent_text: "a change" }] },
    keys: [{ kind: "entity", key: ENERGY, rule: "E2" }],
    items: [
      {
        premise: { kind: "entity", key: ENERGY },
        rule: "E2",
        result: "repair",
        reason: "it changed",
        old_hash: "h-0",
        new_hash: "h-1",
        cause_seq: 1,
        diff: { kind: "entity", before: "a", after: "b" },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 1,
  });

  const heldCard = (): Card => ({
    card_id: "k1",
    kind: "held",
    attempt_ids: ["a1"],
    intent_ids: ["i1"],
    submit_ids: { a1: "s1" },
    title: "a held path",
    body: ["x.js is held."],
    options: [
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ],
    paths: [{ path: "x.js", tier: "held" }],
    blast_radius: {},
    preview: null,
    candidates: null,
    risk: null,
    reason: "held_path",
  });

  /** Accept landing seq 1 for a1 so the landing/push rows have something to act on. */
  function acceptLanding(state: FloorState, ts = 5_000): void {
    reduce(
      state,
      ev(
        "landing.accepted",
        {
          seq: 1,
          batch_id: 1,
          kind: "change",
          attempt_id: "a1",
          change_id: "c_a1",
          intent_id: "i1",
          request_id: null,
          paths: ["x.js"],
          writes: [{ kind: "entity", key: "x.js#f", old: "h-0", new: "h-1" }],
        },
        ts,
      ),
    );
  }

  type Row = {
    type: PoolEvent["type"];
    base?: "empty";
    prepare?: (state: FloorState) => void;
    event: () => PoolEvent;
    check: (state: FloorState) => void;
  };

  const ROWS: Row[] = [
    {
      type: "pool.state",
      event: () =>
        ev("pool.state", {
          head_seq: 7,
          head_commit: "c7",
          green_seq: 2,
          landed_seq: 7,
          landed_commit: "c7",
          state: "paused",
          reason: "diverged",
          epoch: 1,
          remote: "r",
          plain_remote: null,
          rebuild: { done: 1, total: 4 },
          unwitnessed: [3, 4],
          real_agents: 5,
          max_real_agents: 6,
          synthetic: true,
          summary_only: true,
        }),
      check: (s) =>
        expect(s.pool).toMatchObject({
          state: "paused",
          reason: "diverged",
          head_seq: 7,
          unwitnessed: [3, 4],
          rebuild: { done: 1, total: 4 },
          synthetic: true,
          summary_only: true,
          real_agents: 5,
        }),
    },
    {
      type: "pool.files",
      prepare: (s) =>
        reduce(
          s,
          ev("pool.files", {
            files: [
              { path: "a.js", tier: "auto" },
              { path: "b.js", tier: "held" },
            ],
          }),
        ),
      event: () => ev("pool.files", { files: [{ path: "a.js", tier: "held" }] }),
      check: (s) => {
        expect(must(s.files["a.js"])).toMatchObject({ exists: true, tier: "held" });
        expect(must(s.files["b.js"]).exists).toBe(false); // unlisted: no longer exists
      },
    },
    {
      type: "pool.paused",
      event: () => ev("pool.paused", { reason: "owner", detail: "owner_pause" }),
      check: (s) => expect(s.pool).toMatchObject({ state: "paused", reason: "owner" }),
    },
    {
      type: "trunk.error",
      event: () => ev("trunk.error", { where: "tick", code: "crash" }),
      check: (s) => expect(s.trunk_errors).toBe(1),
    },
    {
      type: "intent.created",
      base: "empty",
      event: () =>
        ev(
          "intent.created",
          { intent_id: "i9", text: "a request", requester: "owner", race: false, prewritten: false },
          9_999,
        ),
      check: (s) => {
        expect(must(s.intents.i9)).toMatchObject({ state: "open", text: "a request", requester: "owner" });
        expect(s.first_intent_ts).toBe(9_999);
      },
    },
    {
      type: "intent.state",
      prepare: (s) => openAttempt(s, "a1", "i1"),
      event: () => ev("intent.state", { intent_id: "i1", state: "stopped" }),
      check: (s) => expect(must(s.intents.i1).state).toBe("stopped"),
    },
    {
      type: "attempt.opened",
      prepare: (s) =>
        reduce(
          s,
          ev("intent.created", { intent_id: "i2", text: "t", requester: "owner", race: false, prewritten: false }),
        ),
      event: () =>
        ev("attempt.opened", {
          attempt_id: "a2",
          intent_id: "i2",
          change_id: "c_a2",
          agent: "synthetic",
          model: "m-2",
          race: true,
        }),
      check: (s) => {
        expect(must(s.attempts.a2)).toMatchObject({
          state: "opened",
          intent_id: "i2",
          agent: "synthetic",
          model: "m-2",
          race: true,
        });
        expect(must(s.intents.i2).attempt_ids).toContain("a2");
        expect(s.working_order).toContain("a2");
      },
    },
    {
      type: "attempt.state",
      event: () =>
        ev("attempt.state", {
          attempt_id: "a1",
          from: "working",
          to: "going_around",
          transition: "T8",
          reason: null,
          go_arounds: 1,
          pull_backs: 0,
          right_of_way: false,
        }),
      check: (s) => {
        expect(must(s.attempts.a1)).toMatchObject({ state: "going_around", go_arounds: 1 });
        expect(s.counters.go_arounds).toBe(1); // 4.3: the counter rises when a go-around starts
      },
    },
    {
      type: "attempt.reopened",
      event: () => ev("attempt.reopened", { attempt_id: "a1", cause: "revert", revision: 3, model_changed: true }),
      check: (s) =>
        expect(must(s.attempts.a1)).toMatchObject({ reopened_by: "revert", revision: 3, model_changed: true }),
    },
    {
      type: "attempt.step",
      event: () =>
        ev(
          "attempt.step",
          {
            attempt_id: "a1",
            step: 1,
            tool: "read",
            target: "world/energy.js",
            ok: true,
            error: null,
            ms: 90,
            tokens_in: null,
            tokens_out: null,
            cost_usd: 0.5,
          },
          7_777,
        ),
      check: (s) =>
        expect(must(s.attempts.a1)).toMatchObject({
          steps: 1,
          step: { n: 1, tool: "read", ok: true, ts: 7_777 },
          last_event_ts: 7_777,
          cost_usd: 0.5,
        }),
    },
    {
      type: "attempt.repo",
      event: () => ev("attempt.repo", { attempt_id: "a1", ok: true, ms: 300, error: null }, 6_000),
      check: (s) => expect(s.repos).toMatchObject({ ok: 1, failed: 0, first_ts: 6_000, last_ts: 6_000 }),
    },
    {
      type: "premise.recorded",
      event: () =>
        ev("premise.recorded", {
          attempt_id: "a1",
          tool: "write",
          premise: { kind: "file", key: "y.js", hash: "absent", seq: 0, read: false, edit: true, derived: false },
        }),
      check: (s) => {
        const p = must(must(s.attempts.a1).premises[premiseId("file", "y.js")]);
        expect(p).toMatchObject({ kind: "file", key: "y.js", edit: true, light: "holds" });
      },
    },
    {
      type: "premise.removed",
      event: () => ev("premise.removed", { attempt_id: "a1", kind: "entity", key: ENERGY, rule: "L2" }),
      check: (s) => expect(must(s.attempts.a1).premises[premiseId("entity", ENERGY)]).toBeUndefined(),
    },
    {
      type: "premise.judged",
      event: () =>
        ev("premise.judged", {
          attempt_id: "a1",
          kind: "entity",
          key: ENERGY,
          old_hash: "h-0",
          new_hash: "h-1",
          cause: "landing",
          cause_seq: 1,
          rule: "E2",
          class: "rule",
          result: "repair",
          reason: "it changed",
          clef: null,
        }),
      check: (s) => {
        const p = must(must(s.attempts.a1).premises[premiseId("entity", ENERGY)]);
        expect(p.light).toBe("changed"); // repair shows the change light
        expect(p.judgment).toMatchObject({ rule: "E2", result: "repair", cause_seq: 1 });
      },
    },
    {
      type: "op.recorded",
      event: () =>
        ev("op.recorded", {
          attempt_id: "a1",
          op_seq: 1,
          op: "write",
          path: "y.js",
          targets: ["y.js#f"],
          altered: [],
          added: ["y.js#f"],
          removed: [],
        }),
      check: (s) =>
        expect(must(s.attempts.a1).ops).toContainEqual(
          expect.objectContaining({ op_seq: 1, path: "y.js", dropped: false }),
        ),
    },
    {
      type: "op.dropped",
      prepare: (s) =>
        reduce(
          s,
          ev("op.recorded", {
            attempt_id: "a1",
            op_seq: 1,
            op: "write",
            path: "y.js",
            targets: ["y.js#f"],
            altered: [],
            added: ["y.js#f"],
            removed: [],
          }),
        ),
      event: () => ev("op.dropped", { attempt_id: "a1", op_seqs: [1], path: "y.js", rule: "OP3" }),
      check: (s) => expect(must(s.attempts.a1).ops[0]).toMatchObject({ dropped: true }),
    },
    {
      type: "headsup.sent",
      event: () => ev("headsup.sent", headsUp(8_000), 8_000),
      check: (s) => {
        const attempt = must(s.attempts.a1);
        expect(must(attempt.heads_ups[1])).toMatchObject({
          result: "repair",
          wake: true,
          go_around: 1,
          resolved: null,
        });
        expect(attempt.repair_open_ts).toBe(8_000); // 14.7: the repair clock opens
        expect(must(attempt.premises[premiseId("entity", ENERGY)]).light).toBe("changed");
      },
    },
    {
      type: "headsup.resolved",
      prepare: (s) => {
        reduce(
          s,
          ev("premise.judged", {
            attempt_id: "a1",
            kind: "entity",
            key: ENERGY,
            old_hash: "h-0",
            new_hash: "h-1",
            cause: "landing",
            cause_seq: 1,
            rule: "E2",
            class: "rule",
            result: "repair",
            reason: "r",
            clef: null,
          }),
        );
        reduce(s, ev("headsup.sent", headsUp(8_000), 8_000));
      },
      event: () =>
        ev(
          "headsup.resolved",
          { attempt_id: "a1", hn: 1, result: "repair", go_around: 1, changed: true, statement: "fixed" },
          9_000,
        ),
      check: (s) => {
        const attempt = must(s.attempts.a1);
        expect(must(attempt.heads_ups[1]).resolved).toMatchObject({ changed: true, statement: "fixed", ts: 9_000 });
        expect(must(attempt.premises[premiseId("entity", ENERGY)]).light).toBe("holds"); // warnings return to holds
      },
    },
    {
      type: "submit.result",
      prepare: (s) => reduce(s, ev("headsup.sent", headsUp(8_000), 8_000)),
      event: () =>
        ev(
          "submit.result",
          { attempt_id: "a1", submit_id: "s1", status: "validated", tier: "auto", checks: [], duplicate: false },
          12_000,
        ),
      check: (s) => {
        const attempt = must(s.attempts.a1);
        expect(must(attempt.submit)).toMatchObject({ submit_id: "s1", status: "validated", tier: "auto" });
        expect(s.repair_ms).toEqual([4_000]); // 14.7: validated closes the repair clock
        expect(attempt.repair_open_ts).toBeNull();
      },
    },
    {
      type: "card.opened",
      event: () => ev("card.opened", { card: heldCard() }),
      check: (s) => {
        expect(must(s.cards.k1)).toMatchObject({ open: true });
        expect(s.open_cards).toEqual(["k1"]);
        expect(must(s.attempts.a1).card_id).toBe("k1");
      },
    },
    {
      type: "card.updated",
      prepare: (s) => reduce(s, ev("card.opened", { card: heldCard() })),
      event: () => ev("card.updated", { card: { ...heldCard(), title: "a held path, revised" } }),
      check: (s) => expect(must(s.cards.k1).card.title).toBe("a held path, revised"),
    },
    {
      type: "card.closed",
      prepare: (s) => reduce(s, ev("card.opened", { card: heldCard() })),
      event: () =>
        ev("card.closed", { card_id: "k1", action: "land", by: "owner", attempt_id: null, reason: null }, 10_000),
      check: (s) => {
        const view = must(s.cards.k1);
        expect(view.open).toBe(false);
        expect(view.closed).toMatchObject({ action: "land", by: "owner", ts: 10_000 });
        expect(s.open_cards).toEqual([]);
        expect(must(s.attempts.a1).approved_ts).toBe(10_000); // 4.3: land/choose set approved_ts
      },
    },
    {
      type: "landing.accepted",
      event: () =>
        ev(
          "landing.accepted",
          {
            seq: 1,
            batch_id: 1,
            kind: "change",
            attempt_id: "a1",
            change_id: "c_a1",
            intent_id: "i1",
            request_id: null,
            paths: ["x.js"],
            writes: [{ kind: "entity", key: "x.js#f", old: "h-0", new: "h-1" }],
          },
          5_000,
        ),
      check: (s) => {
        expect(must(s.landings[1])).toMatchObject({ seq: 1, attempt_id: "a1", kind: "change" });
        expect(s.pool.head_seq).toBe(1);
        expect(must(s.attempts.a1).landed_seq).toBe(1);
        expect(must(s.push)).toMatchObject({ batch_id: 1, first_accepted_ts: 5_000, tries: 0 });
      },
    },
    {
      type: "landing.landed",
      prepare: (s) => acceptLanding(s),
      event: () =>
        ev(
          "landing.landed",
          {
            seq: 1,
            batch_id: 1,
            commit: "commit-1",
            tree: "tree-1",
            note: "note-1",
            note_json: JSON.stringify({ v: 1, seq: 1, kind: "change" }),
            time_to_land_ms: 800,
          },
          6_000,
        ),
      check: (s) => {
        expect(view(s.landings[1]).landed).toMatchObject({ commit: "commit-1", ts: 6_000 });
        expect(s.pool).toMatchObject({ landed_seq: 1, landed_commit: "commit-1" });
        expect(s.counters.landed_changes).toBe(1);
        expect(view(s.landings[1]).note).toMatchObject({ seq: 1, kind: "change" });
      },
    },
    {
      type: "batch.pushed",
      prepare: (s) => {
        acceptLanding(s);
        reduce(
          s,
          ev(
            "landing.landed",
            {
              seq: 1,
              batch_id: 1,
              commit: "commit-1",
              tree: "tree-1",
              note: "n-1",
              note_json: null,
              time_to_land_ms: 800,
            },
            6_000,
          ),
        );
      },
      event: () =>
        ev(
          "batch.pushed",
          { batch_id: 1, first_seq: 1, last_seq: 1, main: "commit-1", notes: "n-1", tries: 1, ms: 250 },
          7_000,
        ),
      check: (s) => {
        expect(s.push).toBeNull();
        expect(s.last_push).toEqual({ batch_id: 1, landings: 1, tries: 1, ms: 250 });
      },
    },
    {
      type: "push.retry",
      prepare: (s) => acceptLanding(s),
      event: () => ev("push.retry", { batch_id: 1, tries: 1, error: "http_503", next_try_ms: 2_000 }, 8_000),
      check: (s) =>
        expect(must(s.push)).toMatchObject({ batch_id: 1, tries: 1, error: "http_503", next_try_ts: 10_000 }),
    },
    {
      type: "tick.skipped",
      event: () => ev("tick.skipped", { attempt_id: "a1", why: "not_disjoint", behind: "a9" }),
      check: (s) => expect(must(s.attempts.a1).skipped).toEqual({ why: "not_disjoint", behind: "a9" }),
    },
    {
      type: "undo.planned",
      event: () =>
        ev("undo.planned", {
          request_id: "r1",
          cause: "undo",
          target_seq: 1,
          reverted: [1],
          reopened: ["a1"],
          kept_readers: [],
        }),
      check: (s) =>
        expect(must(s.undo.r1)).toMatchObject({
          cause: "undo",
          target_seq: 1,
          reverted: [1],
          reopened: ["a1"],
          landing_seq: null,
        }),
    },
    {
      type: "undo.refused",
      prepare: (s) =>
        reduce(
          s,
          ev("undo.planned", {
            request_id: "r1",
            cause: "undo",
            target_seq: 1,
            reverted: [1],
            reopened: [],
            kept_readers: [],
          }),
        ),
      event: () => ev("undo.refused", { request_id: "r2", target_seq: 1, reason: "plan_changed" }),
      check: (s) => {
        expect(s.undo.r2).toBeUndefined(); // 4.3: "None."
        expect(must(s.undo.r1)).toBeDefined();
      },
    },
    {
      type: "plain.updated",
      event: () => ev("plain.updated", { commit: "p1", tree: "pt1", through_seq: 4, skipped: [2], interrupted: [3] }),
      check: (s) =>
        expect(must(s.plain)).toMatchObject({
          commit: "p1",
          tree: "pt1",
          through_seq: 4,
          skipped: [2],
          interrupted: [3],
        }),
    },
    {
      type: "green.verified",
      event: () =>
        ev("green.verified", {
          seq: 1,
          commit: "c1",
          ok: false,
          runtime: "isolate",
          checks: [
            { name: "selftest_ran", ok: true },
            { name: "visible", ok: false, code: "visible:failed" },
          ],
          ms: 700,
          confirmed: true,
        }),
      check: (s) => {
        expect(s.green.runtime).toBe("isolate");
        expect(s.green.last).toEqual({
          seq: 1,
          ok: false,
          confirmed: true,
          failed: [{ name: "visible", code: "visible:failed" }],
        });
      },
    },
    {
      type: "green.advanced",
      event: () => ev("green.advanced", { seq: 2, commit: "c2" }),
      check: (s) => expect(s.green).toMatchObject({ seq: 2, commit: "c2" }),
    },
    {
      type: "metrics",
      event: () =>
        ev(
          "metrics",
          {
            window_ms: 60_000,
            landings_per_second: 0.5,
            time_to_land_ms: { p50: 900, p99: 2_000 },
            time_held_ms: { p50: null, p99: null },
            go_around_rate: 0.1,
            false_abort_rate: null,
            escape_rate: null,
            waiting_behind: 1,
            push_backlog: 0,
            tick_cpu_ms: { p50: 3, p99: 9 },
          },
          30_000,
        ),
      check: (s) => {
        expect(must(s.metrics)).toMatchObject({ landings_per_second: 0.5, waiting_behind: 1 });
        expect(s.metrics_history).toContainEqual({ ts: 30_000, landings_per_second: 0.5, go_around_rate: 0.1 });
      },
    },
    {
      type: "limits",
      event: () =>
        ev(
          "limits",
          {
            spend_usd: 12,
            reserved_usd: 1,
            cap_usd: 40,
            killed: true,
            refusing: true,
            models: [{ model: "m-1", per_minute: 60, used_last_minute: 7 }],
          },
          11_000,
        ),
      check: (s) =>
        expect(must(s.limits)).toMatchObject({ spend_usd: 12, cap_usd: 40, killed: true, refusing: true, ts: 11_000 }),
    },
    {
      type: "swarm.state",
      event: () =>
        ev("swarm.state", {
          synthetic: true,
          running: true,
          agents: 4,
          collision_dial: 0.5,
          pools: ["tidepool", "swarm"],
        }),
      check: (s) =>
        expect(must(s.swarm)).toMatchObject({
          running: true,
          agents: 4,
          collision_dial: 0.5,
          pools: ["tidepool", "swarm"],
          ever_ran: true,
        }),
    },
  ];

  it.each(ROWS)("4.3 row `$type` reduces as specified", (row) => {
    const state = row.base === "empty" ? baseState() : world();
    row.prepare?.(state);
    reduce(state, row.event());
    row.check(state);
  });
});

describe("D19: a premise keeps its pin (03-floor 4.1 PremiseView, 5.2 changeName)", () => {
  it("keeps the pin of premise.recorded, follows a later record, and is null for a premise known only from a judgment", () => {
    const state = baseState();
    openAttempt(state, "a1", "i1");
    const created = {
      kind: "file" as const,
      key: "creatures/crab.js",
      hash: "absent",
      seq: 0,
      read: false,
      edit: true,
      derived: false,
    };
    reduce(state, ev("premise.recorded", { attempt_id: "a1", tool: "write", premise: created }, 1_100));
    const fileId = premiseId("file", "creatures/crab.js");
    expect(must(must(state.attempts.a1).premises[fileId]).hash).toBe("absent");
    reduce(
      state,
      ev(
        "premise.recorded",
        { attempt_id: "a1", tool: "read", premise: { ...created, hash: "b1", read: true } },
        1_200,
      ),
    );
    expect(must(must(state.attempts.a1).premises[fileId]).hash).toBe("b1");
    reduce(
      state,
      ev(
        "premise.judged",
        {
          attempt_id: "a1",
          kind: "entity",
          key: ENERGY,
          old_hash: "h0",
          new_hash: "h1",
          cause: "landing",
          cause_seq: 1,
          rule: "E2",
          class: "rule",
          result: "repair",
          reason: "r",
          clef: null,
        },
        1_300,
      ),
    );
    expect(must(must(state.attempts.a1).premises[premiseId("entity", ENERGY)]).hash).toBeNull();
  });
});
