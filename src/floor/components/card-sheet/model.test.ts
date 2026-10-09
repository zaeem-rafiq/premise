// The card-sheet model of 03-floor 3.13/3.14: the held sheet's `frames` of CO36 (the two
// `FrameAddress`es of `Card.preview` and the state-table sentences that stand in for them, FR32)
// and the race sheet's columns (3.14's table: the preview frame only while `can_choose`, the
// state line otherwise, `race.unknown` for a null the card carries — CO39). Expected values come
// from the spec's own copy, never from the implementation (BP1).

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { Card } from "../../../protocol/cards.ts";
import type { FloorState, PremiseView } from "../../../protocol/reducer/state.ts";
import { LIGHTS_MAX } from "../../../protocol/constants.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import { text } from "../../../copy/strings.ts";
import { cardSheetModel } from "./model.ts";
import type { CardSheetModel } from "./model.ts";
/** Record access under noUncheckedIndexedAccess: unwraps or throws. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a defined value");
  return value;
}

let n = 0;
function ev(type: PoolEvent["type"], body: object = {}, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
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

/** One intent plus one attempt working on it. */
function openAttempt(
  state: FloorState,
  attemptId: string,
  intentId: string,
  opts: { race?: boolean; model?: string } = {},
): void {
  if (state.intents[intentId] === undefined) {
    reduce(
      state,
      ev("intent.created", {
        intent_id: intentId,
        text: `text of ${intentId}`,
        requester: "owner",
        race: opts.race === true,
        prewritten: false,
      }),
    );
  }
  reduce(
    state,
    ev("attempt.opened", {
      attempt_id: attemptId,
      intent_id: intentId,
      change_id: `c_${attemptId}`,
      agent: "real",
      model: opts.model ?? "m-1",
      race: opts.race === true,
    }),
  );
  reduce(
    state,
    ev("attempt.state", {
      attempt_id: attemptId,
      from: "opened",
      to: "working",
      transition: "T1",
      reason: null,
      go_arounds: 0,
      pull_backs: 0,
      right_of_way: false,
    }),
  );
}

function heldCard(over: Partial<Card> = {}): Card {
  return {
    card_id: "k_1",
    kind: "held",
    attempt_ids: ["a_1"],
    intent_ids: ["i_1"],
    submit_ids: { a_1: "s_1" },
    title: "This change touches shared rules. Land it?",
    body: ["It changes world/energy.js."],
    options: [
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ],
    paths: [{ path: "world/energy.js", tier: "held" }],
    blast_radius: {},
    preview: null,
    candidates: null,
    risk: null,
    reason: "held_path",
    ...over,
  };
}

function raceCard(over: Partial<Card> = {}): Card {
  return {
    card_id: "k_r",
    kind: "race",
    attempt_ids: ["a_1", "a_2"],
    intent_ids: ["i_1"],
    submit_ids: { a_1: "s_1", a_2: "s_2" },
    title: "Two attempts landed their work. Choose one.",
    body: ["Both passed their checks."],
    options: [{ id: "choose", label: "Choose" }],
    paths: [{ path: "world/energy.js", tier: "auto" }],
    blast_radius: {
      a_1: { repair: [], confirm: [], triage: [], right_of_way: [] },
      a_2: { repair: ["a_9"], confirm: [], triage: [], right_of_way: [] },
    },
    preview: {
      before: { repo: "main", commit: "seed00" },
      after: { a_1: { repo: "main", commit: "c_a1" } },
      error: null,
    },
    candidates: {
      a_1: { state: "submitted", can_choose: true, seconds: 42, cost_usd: 0.12 },
      a_2: { state: "working", can_choose: false, seconds: null, cost_usd: null },
    },
    risk: null,
    reason: "race",
    ...over,
  };
}

function modelOf(
  state: FloorState,
  cardId: string,
  opts: { held?: boolean; clef?: boolean; visitor?: boolean } = {},
): CardSheetModel {
  const view = must(state.cards[cardId]);
  return cardSheetModel(state, view, {
    features: { held: opts.held ?? true, clef: opts.clef ?? true },
    visitor: opts.visitor ?? false,
  });
}

describe.each(["held", "minimal held", "race"] as const)("CO14: %s sheet lights", (surface) => {
  function lightsModel(lights: PremiseView["light"][], summaryOnly = false) {
    const state = baseState();
    openAttempt(state, "a_1", "i_1", { race: surface === "race" });
    for (const [index, light] of lights.entries()) {
      const key = `facts/${index}.js`;
      reduce(
        state,
        ev("premise.recorded", {
          attempt_id: "a_1",
          tool: "read",
          premise: { kind: "file", key, hash: "h0", seq: 0, read: true, edit: false, derived: false },
        }),
      );
      must(must(state.attempts["a_1"]).premises[`file ${key}`]).light = light;
    }
    state.pool.summary_only = summaryOnly;
    const card = surface === "race" ? raceCard() : heldCard();
    reduce(state, ev("card.opened", { card }));
    const model = modelOf(state, card.card_id, { held: surface !== "minimal held" });
    return surface === "race" ? must(model.race?.[0]) : must(model.checked);
  }

  it.each([0, LIGHTS_MAX, 30])("caps %i holds and carries the remaining count", (count) => {
    const model = lightsModel(Array<"holds">(count).fill("holds"));
    expect(model.lights.map((light) => light.id)).toEqual(
      Array.from({ length: Math.min(count, LIGHTS_MAX) }, (_, index) => `file facts/${index}.js`),
    );
    expect(model.lightsMore).toBe(Math.max(0, count - LIGHTS_MAX));
  });

  it("keeps two changed lights recorded after thirty holds ahead of the count", () => {
    const model = lightsModel([...Array<"holds">(30).fill("holds"), "changed", "changed"]);
    expect(model.lights).toHaveLength(LIGHTS_MAX);
    expect(model.lights.slice(0, 2).map((light) => [light.id, light.light])).toEqual([
      ["file facts/30.js", "changed"],
      ["file facts/31.js", "changed"],
    ]);
    expect(model.lights.slice(2).map((light) => light.id)).toEqual(
      Array.from({ length: LIGHTS_MAX - 2 }, (_, index) => `file facts/${index}.js`),
    );
    expect(model.lightsMore).toBe(32 - LIGHTS_MAX);
    expect(model.lights[0]?.tip).toBe("the file facts/30.js: Changed. the agent read it.");
  });

  it("orders changed, blind_spot, confirm, checking, then holds in recorded order", () => {
    const model = lightsModel(["holds", "checking", "holds", "confirm", "blind_spot", "changed"]);
    expect(model.lights.map((light) => [light.id, light.light])).toEqual([
      ["file facts/5.js", "changed"],
      ["file facts/4.js", "blind_spot"],
      ["file facts/3.js", "confirm"],
      ["file facts/1.js", "checking"],
      ["file facts/0.js", "holds"],
      ["file facts/2.js", "holds"],
    ]);
    expect(model.lightsMore).toBe(0);
  });

  it("never hides non-holds even when they exceed LIGHTS_MAX", () => {
    const model = lightsModel(["holds", ...Array<"changed">(LIGHTS_MAX + 2).fill("changed"), "holds"]);
    expect(model.lights).toHaveLength(LIGHTS_MAX + 2);
    expect(model.lights.every((light) => light.light === "changed")).toBe(true);
    expect(model.lightsMore).toBe(2);
  });

  it("shows neither lights nor a hidden count in a summary_only pool", () => {
    const model = lightsModel([...Array<"holds">(30).fill("holds"), "changed"], true);
    expect(model.lights).toEqual([]);
    expect(model.lightsMore).toBe(0);
  });
});

describe("cardSheetModel: the held sheet's frames (3.13, CO36)", () => {
  it("frames are null in the minimal form (HD1: features.held false)", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(state, ev("card.opened", { card: heldCard() }));
    const model = modelOf(state, "k_1", { held: false });
    expect(model.minimal).toBe(true);
    expect(model.frames).toBeNull();
    expect(model.affects).toBeNull();
    expect(model.risk).toBeNull();
  });

  it("preview null: both cells read held.preview_building, buttons stay enabled", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(state, ev("card.opened", { card: heldCard() }));
    const model = modelOf(state, "k_1");
    expect(model.frames).toEqual({
      before: null,
      beforeNote: text("held.preview_building"),
      after: null,
      afterNote: text("held.preview_building"),
    });
  });

  it("CO36: before is Card.preview.before, after is Card.preview.after[attempt_id]", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(
      state,
      ev("card.opened", {
        card: heldCard({
          preview: {
            before: { repo: "main", commit: "seed00" },
            after: { a_1: { repo: "plain", commit: "c_a1" } },
            error: null,
          },
        }),
      }),
    );
    const model = modelOf(state, "k_1");
    expect(model.frames).toEqual({
      before: { repo: "main", commit: "seed00" },
      beforeNote: null,
      after: { repo: "plain", commit: "c_a1" },
      afterNote: null,
    });
  });

  it("FR32: preview.error reads held.no_preview in the after frame", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(
      state,
      ev("card.opened", {
        card: heldCard({
          preview: {
            before: { repo: "main", commit: "seed00" },
            after: {},
            error: "build failed",
          },
        }),
      }),
    );
    const model = modelOf(state, "k_1");
    expect(model.frames?.after).toBeNull();
    expect(model.frames?.afterNote).toBe(text("held.no_preview"));
    expect(model.frames?.before).toEqual({ repo: "main", commit: "seed00" });
  });

  it("FR32: a null before under preview.error reads held.preview_building, not held.no_preview", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(
      state,
      ev("card.opened", {
        card: heldCard({
          preview: { before: null, after: {}, error: "build failed" },
        }),
      }),
    );
    const model = modelOf(state, "k_1");
    expect(model.frames?.before).toBeNull();
    expect(model.frames?.beforeNote).toBe(text("held.preview_building"));
    expect(model.frames?.afterNote).toBe(text("held.no_preview"));
  });

  it("a missing after entry with no error reads held.preview_building (3.13 loading row)", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(
      state,
      ev("card.opened", {
        card: heldCard({
          preview: { before: { repo: "main", commit: "seed00" }, after: {}, error: null },
        }),
      }),
    );
    const model = modelOf(state, "k_1");
    expect(model.frames?.afterNote).toBe(text("held.preview_building"));
  });

  it("a closed card carries no frames — the closing sentence replaces the body", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(state, ev("card.opened", { card: heldCard() }));
    reduce(state, ev("card.closed", { card_id: "k_1", action: "land", by: "owner", attempt_id: null, reason: null }));
    const model = modelOf(state, "k_1");
    expect(model.frames).toBeNull();
    expect(model.closedSentence).toBe(text("held.closed.land"));
    expect(model.closedByOwner).toBe(true);
  });

  it("FR15: a stale card reads held.stale and is not closed by the owner", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    reduce(state, ev("card.opened", { card: heldCard() }));
    reduce(state, ev("card.closed", { card_id: "k_1", action: "stale", by: "system", attempt_id: null, reason: null }));
    const model = modelOf(state, "k_1");
    expect(model.closedSentence).toBe(text("held.stale"));
    expect(model.closedByOwner).toBe(false);
  });
});

describe("cardSheetModel: the race sheet's columns (3.14)", () => {
  function raceState(card: Card = raceCard()): FloorState {
    const state = baseState();
    openAttempt(state, "a_1", "i_1", { race: true, model: "m-fast" });
    openAttempt(state, "a_2", "i_1", { race: true, model: "m-slow" });
    reduce(state, ev("card.opened", { card }));
    return state;
  }

  it("one column per Card.attempt_ids entry, in order", () => {
    const model = modelOf(raceState(), "k_r");
    expect(model.race?.map((column) => column.attemptId)).toEqual(["a_1", "a_2"]);
  });

  it("3.14 live row: a choosable candidate plays its preview and offers Choose", () => {
    const model = modelOf(raceState(), "k_r");
    const column = must(model.race?.[0]);
    expect(column.canChoose).toBe(true);
    expect(column.frameAddress).toEqual({ repo: "main", commit: "c_a1" });
    expect(column.frameNote).toBeNull();
    expect(column.stateLine).toBeNull();
    expect(column.modelId).toBe("m-fast");
    expect(column.took).toBe(text("race.took", { duration: "42 s" }));
    expect(column.cost).toBe(text("race.cost", { money: "$0.12" }));
  });

  it("3.14 loading row: a working candidate shows race.working + status word + steps, no frame", () => {
    const model = modelOf(raceState(), "k_r");
    const column = must(model.race?.[1]);
    expect(column.canChoose).toBe(false);
    expect(column.frameAddress).toBeNull();
    expect(column.frameNote).toBeNull();
    expect(column.stateLine).toBe(`${text("race.working")} · ${text("status.working")} · step 0`);
  });

  it("3.14 error row: a choosable candidate without a preview reads held.no_preview", () => {
    const card = raceCard({
      candidates: { a_1: { state: "submitted", can_choose: true, seconds: 1, cost_usd: 0.01 } },
      preview: { before: { repo: "main", commit: "seed00" }, after: {}, error: null },
    });
    const model = modelOf(raceState(card), "k_r");
    const column = must(model.race?.[0]);
    expect(column.canChoose).toBe(true);
    expect(column.frameAddress).toBeNull();
    expect(column.frameNote).toBe(text("held.no_preview"));
  });

  it("3.14 error row: preview.error reads held.no_preview", () => {
    const card = raceCard({
      preview: { before: null, after: { a_1: { repo: "main", commit: "c_a1" } }, error: "build failed" },
    });
    const model = modelOf(raceState(card), "k_r");
    expect(must(model.race?.[0]).frameNote).toBe(text("held.no_preview"));
    expect(must(model.race?.[0]).frameAddress).toBeNull();
  });

  it("CO39: null seconds and cost read race.unknown inside the labeled sentences, never zero", () => {
    const model = modelOf(raceState(), "k_r");
    const column = must(model.race?.[1]);
    expect(column.took).toBe(text("race.took", { duration: text("race.unknown") }));
    expect(column.cost).toBe(text("race.cost", { money: text("race.unknown") }));
    expect(column.took).not.toContain("0");
  });

  it("race.blast is the repair count of Card.blast_radius[id]", () => {
    const model = modelOf(raceState(), "k_r");
    expect(must(model.race?.[0]).blast).toBe(text("race.blast", { n: 0 }));
    expect(must(model.race?.[1]).blast).toBe(text("race.blast", { n: 1 }));
  });

  it("3.14 stopped row: a stopped attempt shows race.stopped and its stop sentence", () => {
    const state = raceState();
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a_2",
        from: "working",
        to: "stopped",
        transition: "T9",
        reason: "owner_stopped",
        go_arounds: 0,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    const model = modelOf(state, "k_r");
    const column = must(model.race?.[1]);
    expect(column.frameAddress).toBeNull();
    expect(column.stateLine).toContain(text("race.stopped"));
  });

  it("a candidate that went around reads race.stopped with no frame (RC5: can_choose false)", () => {
    const state = raceState();
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: "a_2",
        from: "working",
        to: "going_around",
        transition: "T5",
        reason: null,
        go_arounds: 1,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
    const model = modelOf(state, "k_r");
    const column = must(model.race?.[1]);
    expect(column.canChoose).toBe(false);
    expect(column.frameAddress).toBeNull();
    // Going around is still in flight: the column shows the working line, not a stop.
    expect(column.stateLine).toContain(text("race.working"));
  });

  it("card.closed choose: the chosen column is not choosable, the sheet reads race.closed", () => {
    const state = raceState();
    reduce(
      state,
      ev("card.closed", { card_id: "k_r", action: "choose", by: "owner", attempt_id: "a_1", reason: null }),
    );
    const model = modelOf(state, "k_r");
    expect(must(model.race?.[0]).canChoose).toBe(false);
    expect(must(model.race?.[0]).stateLine).toBe(text("race.chosen"));
    expect(must(model.race?.[1]).stateLine).toBe(text("status.not_chosen"));
    expect(model.closedSentence).toContain("The owner chose ");
  });

  it("3.14 superseded row: every column reads race.superseded", () => {
    const state = raceState();
    reduce(
      state,
      ev("card.closed", { card_id: "k_r", action: "superseded", by: "system", attempt_id: null, reason: null }),
    );
    const model = modelOf(state, "k_r");
    expect(must(model.race?.[0]).stateLine).toBe(text("race.superseded"));
    expect(model.closedSentence).toBe(text("race.superseded"));
  });

  it("a visitor sees no reason field and no Choose on any column (3.14 held row)", () => {
    const model = modelOf(raceState(), "k_r", { visitor: true });
    expect(model.reasonLabel).toBeNull();
    expect(model.race?.map((column) => column.canChoose)).toEqual([false, false]);
    // The columns still show: the choosable candidate keeps its preview frame.
    expect(must(model.race?.[0]).frameAddress).toEqual({ repo: "main", commit: "c_a1" });
  });
});

describe.each([false, true])("D36 3.13: choice sheet for visitor=%s", (visitor) => {
  it("contains only title, at most two sentences and the card options", () => {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    const card = heldCard({
      kind: "choice",
      title: "This change was sent back 3 times. Try again?",
      body: ["It was sent back 3 times.", "Try once more or stop?", "An extra sentence."],
      options: [
        { id: "retry", label: "Try again" },
        { id: "stop", label: "Stop" },
      ],
      reason: "go_around_limit",
    });
    reduce(state, ev("card.opened", { card }));
    const model = modelOf(state, "k_1", { visitor });
    expect(model.title).toBe("This change was sent back 3 times. Try again?");
    expect(model.body).toEqual(["It was sent back 3 times.", "Try once more or stop?"]);
    expect(model.options.map(({ id, label }) => ({ id, label }))).toEqual(card.options);
    for (const value of [
      model.intentLine,
      model.frames,
      model.changes,
      model.affects,
      model.checked,
      model.risk,
      model.reasonLabel,
    ]) {
      expect(value).toBeNull();
    }
  });
});

describe("cardSheetModel: the held sheet's checks column (2.4, 3.13)", () => {
  function heldWithChecks(checks: { name: string; ok: boolean; detail?: string }[]): CardSheetModel {
    const state = baseState();
    openAttempt(state, "a_1", "i_1");
    must(state.attempts["a_1"]).submit = { submit_id: "s_1", status: "held", tier: "held", checks, ts: 1_000 };
    reduce(state, ev("card.opened", { card: heldCard() }));
    return modelOf(state, "k_1");
  }

  it("2.4: with every check passed the column gives the count line and lists no check", () => {
    const model = heldWithChecks([
      { name: "base_current", ok: true },
      { name: "parse", ok: true },
    ]);
    expect(must(model.checked).summary).toBe(text("why.checked.count", { ok: 2, all: 2 }));
    expect(must(model.checked).checks).toBeNull();
  });

  it("2.4: a failed check is listed, and only the failed one", () => {
    const model = heldWithChecks([
      { name: "base_current", ok: true },
      { name: "parse", ok: false, detail: "creatures/crab.js" },
    ]);
    expect(must(model.checked).summary).toBe(text("why.checked.count", { ok: 1, all: 2 }));
    expect(must(model.checked).checks?.map((row) => row.ok)).toEqual([false]);
  });
});
