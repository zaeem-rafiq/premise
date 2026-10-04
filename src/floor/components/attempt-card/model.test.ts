// Unit tests of the attempt-card view model (03-floor 3.2, 3.3, 4.4, 5.3–5.8, 7 FR1–FR3, CO9–CO16).
// Expected values are the specification's own sentences and tables, read off real fixture streams
// (`test/fixtures/streams/`), never off this module's output (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { ReplayHeader } from "../../../protocol/replay.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import type { AttemptView, FloorState, HeadsUpView, PremiseView } from "../../../protocol/reducer/state.ts";
import { emptyFloorState, premiseId } from "../../../protocol/reducer/state.ts";
import {
  cardModel,
  lightsInOrder,
  line4Of,
  newestUnresolvedHeadsUp,
  quietFor,
  sentBack,
  statusOf,
  visibleLights,
} from "./model.ts";

const FIXTURES = join(import.meta.dirname, "../../../../test/fixtures/streams");

/** Parses a Replay file (01-core 12.3): header on line 1, then `events` PoolEvent lines. */
function replayEvents(name: string): PoolEvent[] {
  const lines = readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  if (header.premise_replay !== 2 || header.events !== lines.length - 1) {
    throw new Error(`${name}: not a premise_replay 2 file`);
  }
  return lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
}

/** The state after the events numbered at most `n` of a fixture. */
function stateAt(events: PoolEvent[], n: number): FloorState {
  const state = emptyFloorState();
  for (const event of events) {
    if (event.n > n) break;
    reduce(state, event);
  }
  return state;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

/** A minimal AttemptView for the fabricated rows of the 3.2 state table. */
function attemptView(over: Partial<AttemptView> = {}): AttemptView {
  return {
    id: "a_1",
    intent_id: "i_1",
    change_id: "c-a_1",
    agent: "real",
    model: "model-a",
    race: false,
    state: "working",
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
    revision: 1,
    reopened_by: null,
    model_changed: false,
    opened_ts: 1_000,
    last_event_ts: 2_000,
    step: null,
    steps: 0,
    premises: {},
    ops: [],
    heads_ups: {},
    submit: null,
    repair_open_ts: null,
    skipped: null,
    card_id: null,
    approved_ts: null,
    landed_seq: null,
    cost_usd: null,
    top_ts: null,
    ...over,
  };
}

function premise(over: Partial<PremiseView> = {}): PremiseView {
  return {
    kind: "entity",
    key: "creatures/fish.js#spawn",
    read: true,
    edit: false,
    derived: false,
    light: "holds",
    judgment: null,
    ...over,
  };
}

function headsUp(over: Partial<HeadsUpView> = {}): HeadsUpView {
  return {
    hn: 1,
    result: "repair",
    wake: true,
    ts: 3_000,
    cause: { type: "landing", seqs: [1], changes: [] },
    go_around: 1,
    keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
    items: null,
    dropped_ops: [],
    resolved: null,
    ...over,
  };
}

/** A FloorState holding one attempt of one intent, pool ready with free agent slots. */
function stateWith(attempt: AttemptView, over: Partial<FloorState["pool"]> = {}): FloorState {
  const state = emptyFloorState();
  state.pool = { ...state.pool, id: "tidepool", state: "ready", real_agents: 1, max_real_agents: 6, ...over };
  state.intents["i_1"] = {
    id: "i_1",
    text: "draw tracer fish",
    requester: "owner",
    race: false,
    prewritten: false,
    state: "open",
    created_ts: 500,
    attempt_ids: [attempt.id],
  };
  state.attempts[attempt.id] = attempt;
  return state;
}

describe("03-floor 3.2, 5.3: status word, shape and colour per state", () => {
  const rows: Array<{
    attempt: AttemptView;
    word: string;
    shape: string;
    tone: string;
    line4: string;
    visitor?: boolean;
  }> = [
    {
      attempt: attemptView({ state: "opened" }),
      word: "Starting",
      shape: "ring-dotted",
      tone: "muted",
      line4: "The agent is starting.",
    },
    {
      attempt: attemptView({
        state: "working",
        step: { n: 1, tool: "read", target: "creatures/fish.js", ok: true, error: null, ts: 2_000 },
      }),
      word: "Working",
      shape: "dot",
      tone: "accent",
      line4: "Reading creatures/fish.js",
    },
    {
      attempt: attemptView({ state: "going_around", heads_ups: { 1: headsUp() } }),
      word: "Going around",
      shape: "diamond",
      tone: "changed",
      line4: "ENERGY_MAX changed. The diff was sent to the agent.",
    },
    {
      attempt: attemptView({ state: "needs_confirm", heads_ups: { 1: headsUp({ result: "confirm" }) } }),
      word: "Confirming",
      shape: "triangle",
      tone: "confirm",
      line4: "ENERGY_MAX changed. The agent must confirm.",
    },
    {
      attempt: attemptView({ state: "submitted" }),
      word: "Being checked",
      shape: "half",
      tone: "checking",
      line4: "All checks passed. Waiting for Clef.",
    },
    {
      attempt: attemptView({ state: "validated" }),
      word: "Ready to land",
      shape: "ring",
      tone: "holds",
      line4: "All checks passed. It lands in the next batch.",
    },
    {
      attempt: attemptView({ state: "held", card_id: "k_1" }),
      word: "Waiting for you",
      shape: "bars",
      tone: "confirm",
      line4: "Open the card.",
    },
    {
      attempt: attemptView({ state: "held", card_id: "k_1" }),
      visitor: true,
      word: "Waiting for the owner",
      shape: "bars",
      tone: "confirm",
      line4: "Open the card.",
    },
    {
      attempt: attemptView({ state: "accepted", landed_seq: 1 }),
      word: "Landing…",
      shape: "half",
      tone: "holds",
      line4: "Recorded by Trunk. Being pushed to main.",
    },
    {
      attempt: attemptView({ state: "stopped", stop_reason: "cancelled" }),
      word: "Stopped",
      shape: "cross",
      tone: "changed",
      line4: "The owner stopped this agent. Its work so far is kept.",
    },
    {
      attempt: attemptView({ state: "stopped", stop_reason: "not_chosen" }),
      word: "Not chosen",
      shape: "cross",
      tone: "muted",
      line4: "Another attempt was chosen. This one is kept.",
    },
    {
      attempt: attemptView({ state: "stopped", stop_reason: "undone" }),
      word: "Undone",
      shape: "cross",
      tone: "muted",
      line4: "The owner undid this change.",
    },
    {
      attempt: attemptView({ state: "stopped", stop_reason: "declined" }),
      word: "Declined",
      shape: "cross",
      tone: "muted",
      line4: "The owner declined this change. It is kept, not landed.",
    },
  ];

  it.each(rows)("state $attempt.state shows the status of the table", (row) => {
    const state = stateWith(row.attempt);
    const status = statusOf(state, row.attempt, row.visitor === true);
    expect(status).toEqual({ word: row.word, shape: row.shape, tone: row.tone });
    const line4 = line4Of(state, row.attempt, 5_000, row.visitor === true);
    expect(line4.text).toBe(row.line4);
  });
});

describe("FL3 / AC3: Landing… versus Landed", () => {
  function withLanding(attempt: AttemptView, landed: boolean): FloorState {
    const state = stateWith(attempt);
    state.landings[1] = {
      digest: false,
      seq: 1,
      kind: "change",
      batch_id: 1,
      attempt_id: "a_1",
      change_id: "c-a_1",
      intent_id: "i_1",
      request_id: null,
      paths: ["creatures/fish.js"],
      writes: [],
      accepted_ts: 4_000,
      landed: landed ? { commit: "c0", tree: "t", note_id: "n", ts: 4_500, time_to_land_ms: 100 } : null,
      undone_by: null,
      premises: [],
      go_arounds: [],
      confirms: [],
      checks: [],
      tier: null,
      approved: null,
      risk: null,
      note: null,
    };
    return state;
  }

  it("AC3: a `landed` attempt shows Landing… while its landing.landed has not arrived", () => {
    const attempt = attemptView({ state: "landed", landed_seq: 1 });
    const state = withLanding(attempt, false);
    expect(statusOf(state, attempt, false).word).toBe("Landing…");
    expect(line4Of(state, attempt, 5_000, false).text).toBe("Recorded by Trunk. Being pushed to main.");
  });

  it("AC3: a `landed` attempt shows Landed once its landing.landed has arrived", () => {
    const attempt = attemptView({ state: "landed", landed_seq: 1 });
    const state = withLanding(attempt, true);
    expect(statusOf(state, attempt, false).word).toBe("Landed");
    expect(line4Of(state, attempt, 5_000, false).text).toBe("On main as landing 1.");
  });

  it("AC3: an `accepted` attempt shows Landing…", () => {
    const attempt = attemptView({ state: "accepted", landed_seq: 1 });
    const state = withLanding(attempt, false);
    expect(statusOf(state, attempt, false).word).toBe("Landing…");
  });
});

describe("03-floor 4.4 derived values", () => {
  it("sentBack counts go-arounds and pull-backs (GA3, AC27)", () => {
    expect(sentBack(attemptView({ go_arounds: 0, pull_backs: 0 }))).toBe(0);
    expect(sentBack(attemptView({ go_arounds: 1, pull_backs: 0 }))).toBe(1);
    expect(sentBack(attemptView({ go_arounds: 1, pull_backs: 1 }))).toBe(2);
  });

  it("GA3: sent_back_n shows 'sent back {n} of {GO_AROUND_LIMIT}'", () => {
    const attempt = attemptView({ state: "going_around", go_arounds: 1 });
    expect(cardModel(stateWith(attempt), attempt, 5_000, false).sentBack).toBe("sent back 1 of 3");
    const twice = attemptView({ state: "going_around", go_arounds: 1, pull_backs: 1 });
    expect(cardModel(stateWith(twice), twice, 5_000, false).sentBack).toBe("sent back 2 of 3");
    expect(cardModel(stateWith(attemptView()), attemptView(), 5_000, false).sentBack).toBeNull();
  });

  it("quietFor is clock − last_event_ts on the states it is defined for (FR1)", () => {
    const working = attemptView({ state: "working", last_event_ts: 2_000 });
    expect(quietFor(working, 16_000)).toBe(14_000);
    const held = attemptView({ state: "held", last_event_ts: 2_000 });
    expect(quietFor(held, 16_000)).toBe(0);
  });
});

describe("03-floor 3.3: premise lights (CO14, CO15, CO16)", () => {
  it("CO14: lights order changed, blind_spot, confirm, checking, then holds in recorded order", () => {
    const attempt = attemptView({
      premises: {
        [premiseId("entity", "a.js#one")]: premise({ key: "a.js#one", light: "holds" }),
        [premiseId("entity", "b.js#two")]: premise({ key: "b.js#two", light: "checking" }),
        [premiseId("entity", "c.js#three")]: premise({ key: "c.js#three", light: "changed" }),
        [premiseId("entity", "d.js#four")]: premise({ key: "d.js#four", light: "confirm" }),
        [premiseId("entity", "e.js#five")]: premise({ key: "e.js#five", light: "holds" }),
        [premiseId("entity", "f.js#six")]: premise({ key: "f.js#six", light: "blind_spot" }),
      },
    });
    const keys = lightsInOrder(attempt).map((p) => `${p.light}:${p.key}`);
    expect(keys).toEqual([
      "changed:c.js#three",
      "blind_spot:f.js#six",
      "confirm:d.js#four",
      "checking:b.js#two",
      "holds:a.js#one",
      "holds:e.js#five",
    ]);
  });

  it("CO14: at most LIGHTS_MAX lights, and non-holds lights are never hidden", () => {
    const premises: Record<string, PremiseView> = {
      [premiseId("entity", "x.js#c1")]: premise({ key: "x.js#c1", light: "changed" }),
      [premiseId("entity", "x.js#c2")]: premise({ key: "x.js#c2", light: "blind_spot" }),
      [premiseId("entity", "x.js#c3")]: premise({ key: "x.js#c3", light: "confirm" }),
    };
    for (let index = 0; index < 16; index += 1) {
      const key = `f.js#h${index}`;
      premises[premiseId("entity", key)] = premise({ key, light: "holds" });
    }
    const attempt = attemptView({ premises });
    const { lights, more } = visibleLights(stateWith(attempt), attempt);
    expect(lights).toHaveLength(14);
    expect(lights.slice(0, 3).map((light) => light.light)).toEqual(["changed", "blind_spot", "confirm"]);
    expect(more).toBe(5);
    // Every hidden light is a holds light.
    expect(lights.filter((light) => light.light !== "holds")).toHaveLength(3);
  });

  it("CO16/AX7: a light's accessible name is light.tip with its flags", () => {
    const attempt = attemptView({
      premises: {
        [premiseId("entity", "creatures/fish.js#spawn")]: premise({ read: true, edit: true }),
      },
    });
    const { lights } = visibleLights(stateWith(attempt), attempt);
    expect(lights[0]?.tip).toBe("spawn in creatures/fish.js: Holds. the agent read it, this change edits it.");
  });

  it("CO16: a blind spot's name is light.blind_spot.tip", () => {
    const attempt = attemptView({
      premises: {
        [premiseId("entity", "world/energy.js#ENERGY_MAX")]: premise({
          key: "world/energy.js#ENERGY_MAX",
          read: false,
          derived: true,
          light: "blind_spot",
        }),
      },
    });
    const { lights } = visibleLights(stateWith(attempt), attempt);
    expect(lights[0]?.tip).toBe("The new code uses ENERGY_MAX in world/energy.js, and the agent never read it.");
  });

  it("CO13a/AC26: a summary_only pool shows no lights on the card", () => {
    const attempt = attemptView({
      premises: { [premiseId("entity", "creatures/fish.js#spawn")]: premise() },
    });
    const state = stateWith(attempt, { summary_only: true });
    const { lights, more } = visibleLights(state, attempt);
    expect(lights).toEqual([]);
    expect(more).toBe(0);
    expect(cardModel(state, attempt, 5_000, true).relies).toBe(false);
  });
});

describe("03-floor 7, rows FR1–FR3: the error overlay of line 4", () => {
  it("FR1: after QUIET_NOTICE_MS the activity line counts seconds", () => {
    const attempt = attemptView({ state: "working", last_event_ts: 2_000 });
    const line4 = line4Of(stateWith(attempt), attempt, 16_000, false);
    expect(line4).toEqual({ text: "Thinking · 14 s", warning: false, opensCard: false });
  });

  it("FR1: at SLOW_NOTICE_MS the line reads attempt.slow in the warning colour", () => {
    const attempt = attemptView({ state: "working", last_event_ts: 2_000 });
    const line4 = line4Of(stateWith(attempt), attempt, 32_000, false);
    expect(line4).toEqual({
      text: "The model has not answered for 30 s. It is tried again by itself. If that fails, the attempt stops.",
      warning: true,
      opensCard: false,
    });
  });

  it("FR2: a failed step shows the activity line with its reason, in the warning colour", () => {
    const attempt = attemptView({
      state: "working",
      step: { n: 2, tool: "read", target: "creatures/fish.js", ok: false, error: "not_found", ts: 4_000 },
      last_event_ts: 4_000,
    });
    const line4 = line4Of(stateWith(attempt), attempt, 5_000, false);
    expect(line4).toEqual({
      text: "Reading creatures/fish.js did not work: it does not exist. The agent tries another way.",
      warning: true,
      opensCard: false,
    });
  });

  it("FR3: a rejected submit shows the 5.7 sentence; the go-around count does not rise", () => {
    const attempt = attemptView({
      state: "working",
      go_arounds: 0,
      submit: {
        submit_id: "s_1",
        status: "rejected",
        tier: null,
        checks: [{ name: "parse", ok: false }],
        ts: 4_000,
      },
      last_event_ts: 4_000,
    });
    const model = cardModel(stateWith(attempt), attempt, 5_000, false);
    expect(model.line4).toEqual({
      text: "The checks sent it back: the code does not parse. The agent is fixing it.",
      warning: true,
      opensCard: false,
    });
    expect(model.sentBack).toBeNull();
  });
});

describe("03-floor 4.3: submit, skip and heads-up lines of live states", () => {
  it("5.7: a `held` submit on a still-working attempt shows the waiting line", () => {
    const attempt = attemptView({
      state: "working",
      step: { n: 3, tool: "submit", target: null, ok: true, error: null, ts: 3_500 },
      submit: { submit_id: "s_1", status: "held", tier: "held", checks: [], ts: 4_000 },
      last_event_ts: 4_000,
    });
    const model = cardModel(stateWith(attempt), attempt, 5_000, true);
    expect(model.line4.text).toBe("All checks passed. Waiting for the owner.");
  });

  it("5.6: a validated attempt skipped for right_of_way shows the skip sentence", () => {
    const attempt = attemptView({
      state: "validated",
      skipped: { why: "right_of_way", behind: "a_2" },
      last_event_ts: 6_000,
    });
    const state = stateWith(attempt);
    state.intents["i_2"] = {
      id: "i_2",
      text: "draw tracer fish",
      requester: "owner",
      race: false,
      prewritten: false,
      state: "landed",
      created_ts: 400,
      attempt_ids: ["a_2"],
    };
    state.attempts["a_2"] = attemptView({ id: "a_2", intent_id: "i_2", state: "landed", landed_seq: 1 });
    expect(line4Of(state, attempt, 7_000, false).text).toBe(
      'Waiting behind "draw tracer fish", which has right of way.',
    );
  });

  it("5.6: an unresolved info heads-up is a neutral line on the working card", () => {
    const attempt = attemptView({
      state: "working",
      step: { n: 1, tool: "read", target: "a.js", ok: true, error: null, ts: 2_000 },
      heads_ups: { 1: headsUp({ result: "info", ts: 3_000 }) },
      last_event_ts: 3_000,
    });
    expect(line4Of(stateWith(attempt), attempt, 5_000, false).text).toBe("ENERGY_MAX changed. The agent was told.");
  });

  it("4.3: a resolved heads-up leaves line 4 to the activity line again", () => {
    const attempt = attemptView({
      state: "going_around",
      step: { n: 5, tool: "replace", target: "creatures/crab.js", ok: true, error: null, ts: 4_500 },
      heads_ups: {
        1: headsUp({ resolved: { statement: "adapted", changed: true, ts: 4_000 } }),
      },
      last_event_ts: 4_500,
    });
    expect(newestUnresolvedHeadsUp(attempt)).toBeNull();
    expect(line4Of(stateWith(attempt), attempt, 5_000, false).text).toBe("Editing creatures/crab.js");
  });
});

describe("CO13: a reopened attempt (01-core UN6)", () => {
  it("shows the Reopened-by-undo tag and attempt.same_agent until it lands or stops", () => {
    const attempt = attemptView({ state: "working", reopened_by: "undo" });
    const model = cardModel(stateWith(attempt), attempt, 5_000, false);
    expect(model.tags).toContain("Reopened by undo");
    expect(model.note).toBe("Same agent, same conversation.");
    const landed = attemptView({ state: "landed", reopened_by: "undo", landed_seq: 1 });
    const state = stateWith(landed);
    expect(cardModel(state, landed, 5_000, false).note).toBeNull();
    expect(cardModel(state, landed, 5_000, false).tags).toContain("Reopened by undo");
  });

  it("shows attempt.model_changed when a different model continues the work", () => {
    const attempt = attemptView({ state: "working", reopened_by: "retry", model_changed: true });
    const model = cardModel(stateWith(attempt), attempt, 5_000, false);
    expect(model.tags).toContain("Reopened by the owner");
    expect(model.note).toBe("A different model is continuing this work. The model that started it was not available.");
  });
});

describe("the tracer fixture (01-core 12.3, 03-floor 4.3)", () => {
  const events = replayEvents("tracer.ndjson");

  it("event 15: a_T works, line 4 is the replace step, its two premises hold", () => {
    const state = stateAt(events, 15);
    const attempt = must(state.attempts.a_T);
    const model = cardModel(state, attempt, state.ts, true);
    expect(model.status.word).toBe("Working");
    expect(model.line4.text).toBe("Editing creatures/fish.js");
    expect(model.lights.map((light) => light.light)).toEqual(["holds", "holds"]);
    expect(must(model.lights[0]).tip).toBe(
      "spawn in creatures/fish.js: Holds. the agent read it, this change edits it.",
    );
  });

  it("event 17: the held submit shows the waiting line while a_T still works (5.7)", () => {
    const state = stateAt(events, 17);
    const attempt = must(state.attempts.a_T);
    expect(attempt.state).toBe("working");
    expect(cardModel(state, attempt, state.ts, true).line4.text).toBe("All checks passed. Waiting for the owner.");
  });

  it("event 18: held reads 'Waiting for the owner' to a visitor and offers the card", () => {
    const state = stateAt(events, 18);
    const attempt = must(state.attempts.a_T);
    const model = cardModel(state, attempt, state.ts, true);
    expect(model.status.word).toBe("Waiting for the owner");
    expect(model.line4).toEqual({ text: "Open the card.", warning: false, opensCard: true });
    const owner = cardModel(state, attempt, state.ts, false);
    expect(owner.status.word).toBe("Waiting for you");
  });

  it("event 23: accepted reads 'Landing…' and 'Recorded by Trunk. Being pushed to main.' (FL3)", () => {
    const state = stateAt(events, 23);
    const attempt = must(state.attempts.a_T);
    const model = cardModel(state, attempt, state.ts, true);
    expect(model.status.word).toBe("Landing…");
    expect(model.line4.text).toBe("Recorded by Trunk. Being pushed to main.");
  });

  it("event 27: landed reads 'Landed' and 'On main as landing 1.'", () => {
    const state = stateAt(events, 27);
    const attempt = must(state.attempts.a_T);
    const model = cardModel(state, attempt, state.ts, true);
    expect(model.status.word).toBe("Landed");
    expect(model.line4.text).toBe("On main as landing 1.");
  });

  it("event 36: a_U skipped behind a_T shows the right-of-way sentence (5.6)", () => {
    const state = stateAt(events, 36);
    const attempt = must(state.attempts.a_U);
    expect(attempt.skipped).toEqual({ why: "right_of_way", behind: "a_T" });
    expect(cardModel(state, attempt, state.ts, true).line4.text).toBe(
      'Waiting behind "draw tracer fish", which has right of way.',
    );
  });

  it("event 40: the undo reopens a_T with its tag while it is still `landed` (CO13)", () => {
    const state = stateAt(events, 40);
    const attempt = must(state.attempts.a_T);
    expect(attempt.reopened_by).toBe("undo");
    expect(attempt.state).toBe("landed");
    const model = cardModel(state, attempt, state.ts, true);
    expect(model.tags).toContain("Reopened by undo");
    // The note follows while it works again; a still-`landed` attempt does not show it yet.
    expect(model.note).toBeNull();
  });
});

describe("the hero-c04 fixture: a real go-around (GA3, CO14)", () => {
  const events = replayEvents("hero-c04.ndjson");

  it("event 30: a_A goes around with the repair heads-up sentence and a changed light", () => {
    const state = stateAt(events, 30);
    const attempt = must(state.attempts.a_A);
    expect(attempt.state).toBe("going_around");
    const model = cardModel(state, attempt, state.ts, false);
    expect(model.status).toEqual({ word: "Going around", shape: "diamond", tone: "changed" });
    expect(model.sentBack).toBe("sent back 1 of 3");
    expect(model.line4.text).toBe("ENERGY_MAX changed. The diff was sent to the agent.");
    expect(model.lights[0]?.light).toBe("changed");
    expect(model.lights[0]?.tip).toContain("ENERGY_MAX in world/energy.js: Changed.");
  });

  it("event 37: the resolved heads-up returns the light to holds and the line to activity", () => {
    const state = stateAt(events, 37);
    const attempt = must(state.attempts.a_A);
    const model = cardModel(state, attempt, state.ts, false);
    expect(model.lights.every((light) => light.light === "holds")).toBe(true);
    expect(model.line4.text).toBe("Editing creatures/crab.js");
  });
});
