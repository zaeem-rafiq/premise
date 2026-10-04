// Markup tests of the attempt card (03-floor 3.2, 3.3, CP6–CP8, AX7, FL8): rendered with
// `renderToStaticMarkup` over real fixture states and fabricated rows. Expected values are the
// specification's sentences and rules, never this component's own output (BP1).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { ReplayHeader } from "../../../protocol/replay.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import type { AttemptView, FloorState } from "../../../protocol/reducer/state.ts";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { AttemptCard } from "./attempt-card.tsx";

const FIXTURES = join(import.meta.dirname, "../../../../test/fixtures/streams");

function replayEvents(name: string): PoolEvent[] {
  const lines = readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  if (header.premise_replay !== 2) throw new Error(`${name}: not a premise_replay 2 file`);
  return lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
}

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

function cardHtml(state: FloorState, attempt: AttemptView, visitor: boolean, compact = false): string {
  return renderToStaticMarkup(createElement(AttemptCard, { attempt, state, clock: state.ts, visitor, compact }));
}

describe("03-floor 3.2: the collapsed attempt card on the tracer fixture", () => {
  const events = replayEvents("tracer.ndjson");

  it("event 15: requester, intent in quotes, model, status word and lights", () => {
    const state = stateAt(events, 15);
    const html = cardHtml(state, must(state.attempts.a_T), true);
    expect(html).toContain('data-attempt-id="a_T"');
    expect(html).toContain("owner");
    expect(html).toContain("model-a");
    expect(html).toContain("Working");
    expect(html).toContain("“draw tracer fish”");
    expect(html).toContain("Editing creatures/fish.js");
    expect(html).toContain("Relies on");
    expect(html.match(/role="img"/g)?.length).toBe(2);
    expect(html).toContain('aria-label="spawn in creatures/fish.js: Holds. the agent read it, this change edits it."');
  });

  it("event 18: held shows 'Waiting for the owner' to a visitor and 'Open the card.'", () => {
    const state = stateAt(events, 18);
    const html = cardHtml(state, must(state.attempts.a_T), true);
    expect(html).toContain("Waiting for the owner");
    expect(html).toContain("Open the card.");
  });

  it("event 18: held shows 'Waiting for you' to the owner (CP7)", () => {
    const state = stateAt(events, 18);
    const html = cardHtml(state, must(state.attempts.a_T), false);
    expect(html).toContain("Waiting for you");
  });

  it("event 23: accepted shows 'Landing…' before its landing.landed (AC3)", () => {
    const state = stateAt(events, 23);
    const html = cardHtml(state, must(state.attempts.a_T), true);
    expect(html).toContain("Landing…");
    expect(html).not.toContain(">Landed<");
    expect(html).toContain("Recorded by Trunk. Being pushed to main.");
  });

  it("event 27: landed shows 'Landed' and 'On main as landing 1.'", () => {
    const state = stateAt(events, 27);
    const html = cardHtml(state, must(state.attempts.a_T), true);
    expect(html).toContain("Landed");
    expect(html).toContain("On main as landing 1.");
  });

  it("FL8/AC8: text from outside is text, never HTML", () => {
    const state = emptyFloorState();
    state.pool.state = "ready";
    state.intents["i_1"] = {
      id: "i_1",
      text: '<img src=x onerror="alert(1)">',
      requester: "owner",
      race: false,
      prewritten: false,
      state: "open",
      created_ts: 0,
      attempt_ids: ["a_1"],
    };
    state.attempts["a_1"] = {
      ...emptyAttempt(),
      id: "a_1",
      intent_id: "i_1",
      state: "working",
    };
    const html = cardHtml(state, must(state.attempts.a_1), true);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('dir="auto"');
  });

  it("CO10: the compact card carries intent, status, lights and model on two lines", () => {
    const state = stateAt(events, 15);
    const html = cardHtml(state, must(state.attempts.a_T), true, true);
    expect(html).toContain("attempt-card--compact");
    expect(html).toContain("model-a");
    expect(html).toContain("Working");
    expect(html).toContain("Relies on");
  });
});

describe("03-floor 3.2: the hero-c04 go-around", () => {
  const events = replayEvents("hero-c04.ndjson");

  it("event 30: Going around, sent back 1 of 3, the heads-up line and the changed light", () => {
    const state = stateAt(events, 30);
    const html = cardHtml(state, must(state.attempts.a_A), false);
    expect(html).toContain("Going around");
    expect(html).toContain("sent back 1 of 3");
    expect(html).toContain("ENERGY_MAX changed. The diff was sent to the agent.");
    expect(html).toContain("ENERGY_MAX in world/energy.js: Changed.");
    expect(html).toContain('class="light light--changed"');
  });
});

function emptyAttempt(): AttemptView {
  return {
    id: "",
    intent_id: "",
    change_id: "",
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
    opened_ts: 0,
    last_event_ts: 0,
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
  };
}
