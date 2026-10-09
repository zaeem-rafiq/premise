// D14: the Needs-you badge and key N follow 3.19 and CO38. The badge counts "the open cards
// that can be answered" and "opens the oldest open card"; a race card is counted "only while
// at least one candidate has `can_choose: true`". The state comes through the reducer.

import { expect, it } from "vitest";
import type { Card } from "../../protocol/cards.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import { emptyFloorState, reduce } from "../../protocol/reducer/index.ts";
import type { FloorState } from "../../protocol/reducer/index.ts";
import { needsCards } from "./needs.ts";

const RADIUS = { repair: [], confirm: [], triage: [], right_of_way: [] };

function raceCard(ready: boolean): Card {
  return {
    card_id: "k_race",
    kind: "race",
    attempt_ids: ["a_1", "a_2"],
    intent_ids: ["i_1"],
    submit_ids: {},
    title: ready
      ? '1 of 2 attempts at "a faster crab" is ready. Choose it, or wait for the others.'
      : '2 attempts at "a faster crab" are still working.',
    body: [],
    options: [{ id: "choose", label: "Choose this one" }],
    paths: [],
    blast_radius: { a_1: RADIUS, a_2: RADIUS },
    preview: null,
    candidates: {
      a_1: { state: ready ? "submitted" : "working", can_choose: ready, seconds: null, cost_usd: null },
      a_2: { state: "working", can_choose: false, seconds: null, cost_usd: null },
    },
    risk: null,
    reason: "race",
  };
}

const HELD: Card = {
  card_id: "k_held",
  kind: "held",
  attempt_ids: ["a_3"],
  intent_ids: ["i_2"],
  submit_ids: { a_3: "s_3" },
  title: "This change touches shared rules. Land it?",
  body: ["It changes world/energy.js."],
  options: [
    { id: "land", label: "Land" },
    { id: "decline", label: "Decline" },
  ],
  paths: [{ path: "world/energy.js", tier: "held" }],
  blast_radius: { a_3: RADIUS },
  preview: null,
  candidates: null,
  risk: null,
  reason: "held_path",
};

let n = 0;
function play(state: FloorState, fields: Record<string, unknown>): FloorState {
  n += 1;
  return reduce(state, { n, t: 1_000 + n, ts: 1_000 + n, src: "trunk", pool: "testpool", ...fields } as PoolEvent);
}

it("D14 CO38 3.19: a race counts only once a candidate can be chosen; the oldest answerable card comes first", () => {
  let floor = play(emptyFloorState(), { type: "card.opened", card: raceCard(false) });
  // The race started with no candidate ready: nothing can be answered yet.
  expect(floor.open_cards).toEqual(["k_race"]);
  expect(needsCards(floor)).toEqual([]);

  // A held card opens later: it is the one card to answer, though the race is older.
  floor = play(floor, { type: "card.opened", card: HELD });
  expect(needsCards(floor)).toEqual(["k_held"]);

  // A candidate becomes choosable: both count, oldest first.
  floor = play(floor, { type: "card.updated", card: raceCard(true) });
  expect(needsCards(floor)).toEqual(["k_race", "k_held"]);

  // A closed card leaves the count.
  floor = play(floor, {
    type: "card.closed",
    card_id: "k_held",
    action: "land",
    by: "owner",
    attempt_id: null,
    reason: null,
  });
  expect(needsCards(floor)).toEqual(["k_race"]);
});
