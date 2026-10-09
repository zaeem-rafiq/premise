// D14 (CO38, 3.19, 6.6): the Needs-you badge shows "the number of open cards that can be
// answered" and "opens the oldest open card"; key N opens "the oldest card that needs the owner".
// A race card counts "only while at least one candidate has `can_choose: true`". Titles are the
// 5.10 forms; the badge is `needs.badge` in the owner's live form.

import { expect, test } from "@playwright/test";
import { attemptOpened, attemptState, ev, intentCreated, poolState, type Frame } from "./stream.ts";
import { serveReview } from "../rail/review-fixtures.ts";

const RADIUS = { repair: [], confirm: [], triage: [], right_of_way: [] };
const RACE_WORKING = '2 attempts at "a faster crab" are still working.';
const RACE_READY = '1 of 2 attempts at "a faster crab" is ready. Choose it, or wait for the others.';
const HELD_TITLE = "This change touches shared rules. Land it?";

function raceCard(ready: boolean): Frame {
  return {
    card_id: "k_race",
    kind: "race",
    attempt_ids: ["a_1", "a_2"],
    intent_ids: ["i_1"],
    submit_ids: ready ? { a_1: "s_1" } : {},
    title: ready ? RACE_READY : RACE_WORKING,
    body: ["Each ran on a different model. The one you choose lands through the same gate."],
    options: [{ id: "choose", label: "Choose this one" }],
    paths: [],
    blast_radius: { a_1: RADIUS, a_2: RADIUS },
    preview: null,
    candidates: {
      a_1: { state: ready ? "submitted" : "working", can_choose: ready, seconds: ready ? 42 : null, cost_usd: null },
      a_2: { state: "working", can_choose: false, seconds: null, cost_usd: null },
    },
    risk: null,
    reason: "race",
  };
}

const HELD: Frame = {
  card_id: "k_held",
  kind: "held",
  attempt_ids: ["a_3"],
  intent_ids: ["i_2"],
  submit_ids: { a_3: "s_3" },
  title: HELD_TITLE,
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

test("D14 CO38 3.19: a race with no candidate ready is not counted; the badge and N open the oldest card to answer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const push = await serveReview(page, [
    poolState(1),
    { ...intentCreated(2, "i_1", "a faster crab"), race: true },
    attemptOpened(3, "a_1", "i_1", { race: true }),
    attemptOpened(4, "a_2", "i_1", { race: true }),
    attemptState(5, "a_1", "opened", "working"),
    attemptState(6, "a_2", "opened", "working"),
    ev(7, { type: "card.opened", card: raceCard(false) }),
  ]);
  await page.goto("/p/testpool");
  await expect(page.locator(".attempt-card")).toHaveCount(2);
  const badge = page.locator(".needs-badge");
  const sheet = page.locator(".card-sheet");

  // The race has started and no candidate can be chosen: the badge is absent, the tray is
  // empty, and N has nothing to open.
  await expect(badge).toHaveCount(0);
  await expect(page.locator(".tray")).toHaveCount(0);
  await page.keyboard.press("n");
  await page.waitForTimeout(300);
  await expect(sheet).toHaveCount(0);

  // A held card opens after the race card: it is the one card to answer.
  push([
    intentCreated(8, "i_2", "make energy a fraction from 0 to 1"),
    attemptOpened(9, "a_3", "i_2"),
    attemptState(10, "a_3", "opened", "working"),
    attemptState(11, "a_3", "working", "held", { reason: "held_path" }),
    ev(12, { type: "card.opened", card: HELD }),
  ]);
  await expect(badge).toHaveText("Needs you 1");
  await expect(page.locator(".tray-row")).toHaveCount(1);
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: HELD_TITLE })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // A candidate can be chosen now: both cards count, and the race is the oldest of them.
  push([ev(13, { type: "card.updated", card: raceCard(true) })]);
  await expect(badge).toHaveText("Needs you 2");
  await expect(page.locator(".tray-row .tray-title")).toHaveText([RACE_READY, HELD_TITLE]);
  await badge.click();
  await expect(page.getByRole("dialog", { name: RACE_READY })).toBeVisible();
});
