// The race sheet of 03-floor 3.14 (plan 2.6 item 5): one column per candidate of
// `Card.attempt_ids` — the preview frame while `can_choose`, the state line otherwise (working /
// stopped / chosen / not_chosen / superseded), `race.unknown` for the nulls of CO39 — and Choose
// sending `option: "choose"` with the column's `attempt_id` (CD4, CO38a, AC22). `card.closed`
// `choose` shows `race.closed` and closes after 1.5 s; `superseded` shows `race.superseded`. A
// visitor gets no buttons. Expected values come from the spec's copy tables, never the page (BP1).

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  ev,
  FLOOR_JSON,
  intentCreated,
  attemptOpened,
  attemptState,
  poolState,
  serveSession,
  POOL,
} from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";
import { densePremises, expectLightsInsideColumn, expectNoSheetOverflow } from "./sheet-lights.ts";

/** The fake pool host: a document the commit iframes can load. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  parent.postMessage({ type: "stats", source: location.pathname.split("/")[3], version: "c-1",
    seq: 1, tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
</script>`;

function raceCard(over: Frame = {}): Frame {
  return {
    card_id: "k_r",
    kind: "race",
    attempt_ids: ["a_1", "a_2"],
    intent_ids: ["i_1"],
    submit_ids: { a_1: "s_1", a_2: "s_2" },
    title: "Two attempts answered. Choose one.",
    body: ["Both passed their checks."],
    options: [{ id: "choose", label: "Choose" }],
    paths: [{ path: "world/energy.js", tier: "auto" }],
    blast_radius: {
      a_1: { repair: [], confirm: [], triage: [], right_of_way: [] },
      a_2: { repair: ["a_9"], confirm: [], triage: [], right_of_way: [] },
    },
    preview: {
      before: { repo: "main", commit: "c_seed" },
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

/** The race stream: one intent, two racing attempts working, the card open. */
const RACE_STREAM = (card: Frame) => [
  poolState(1),
  intentCreated(2, "i_1", "a faster fish"),
  attemptOpened(3, "a_1", "i_1", { model: "model-a", race: true }),
  attemptOpened(4, "a_2", "i_1", { model: "model-a", race: true }),
  attemptState(5, "a_1", "opened", "working"),
  attemptState(6, "a_2", "opened", "working"),
  ev(7, { type: "card.opened", card }),
];

type CapturedRequest = { url: string; body: Record<string, unknown> };

async function serve(
  page: Page,
  frames: Frame[],
  opts: { owner?: boolean; sent?: CapturedRequest[]; wsRef?: { ws?: { send: (m: string) => void } } } = {},
): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await serveSession(page, opts.owner === true);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await page.route("**/api/pools/*/cards/*", async (route: Route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    opts.sent?.push({ url: route.request().url(), body });
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    opts.wsRef && (opts.wsRef.ws = ws);
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
}

test.describe("the race sheet (3.14)", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`CO14: three dense candidates keep their lights inside each column at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const ids = ["a_1", "a_2", "a_3"];
      const card = raceCard({
        attempt_ids: ids,
        submit_ids: Object.fromEntries(ids.map((id, index) => [id, `s_${index + 1}`])),
        title: "Three attempts answered. Choose one.",
        body: ["All three passed their checks."],
        blast_radius: Object.fromEntries(
          ids.map((id) => [id, { repair: [], confirm: [], triage: [], right_of_way: [] }]),
        ),
        candidates: Object.fromEntries(
          ids.map((id) => [id, { state: "held", can_choose: true, seconds: 42, cost_usd: 0.12 }]),
        ),
        preview: {
          before: { repo: "main", commit: "c_seed" },
          after: Object.fromEntries(ids.map((id) => [id, { repo: "main", commit: `c_${id}` }])),
          error: null,
        },
      });
      const frames = [poolState(1), { ...intentCreated(2, "i_1", "a faster crab"), race: true }];
      let n = 3;
      for (const [index, id] of ids.entries()) {
        frames.push(attemptOpened(n++, id, "i_1", { race: true, model: `model-${index + 1}` }));
        frames.push(attemptState(n++, id, "opened", "working"));
        const premises = densePremises(n, id, index === 1 ? 2 : 0);
        frames.push(...premises);
        n += premises.length;
        frames.push(
          ev(n++, {
            type: "submit.result",
            attempt_id: id,
            submit_id: `s_${index + 1}`,
            status: "held",
            tier: "auto",
            checks: [{ name: "typecheck", ok: true }],
            duplicate: false,
          }),
        );
        frames.push(attemptState(n++, id, "working", "held"));
      }
      frames.push(ev(n, { type: "card.opened", card }));
      await serve(page, frames, { owner: true });
      await page.goto(`/p/${POOL}`);
      await page.locator(".tray").getByRole("button", { name: "Open" }).click();
      const sheet = page.getByRole("dialog", { name: "Three attempts answered. Choose one." });
      await expect(sheet).toBeVisible();
      const columns = sheet.locator(".card-sheet__candidate");
      await expect(columns).toHaveCount(3);
      for (let index = 0; index < ids.length; index += 1) {
        await expectLightsInsideColumn(columns.nth(index), index === 1 ? 18 : 16, index === 1 ? 2 : 0);
      }
      await expectNoSheetOverflow(sheet);
      await sheet.screenshot({ path: testInfo.outputPath("race-sheet-lights.png") });
      expect(errors).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    });
  }

  test("one column per candidate in Card.attempt_ids order: frame, model, facts, state line, Choose only where can_choose", async ({
    page,
  }) => {
    await serve(page, RACE_STREAM(raceCard()), { owner: true });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("Two attempts answered. Choose one.")).toBeVisible();
    const columns = sheet.locator(".card-sheet__candidate");
    await expect(columns).toHaveCount(2);
    // In the card's attempt_ids order: a_1 first.
    await expect(columns.nth(0)).toHaveAttribute("data-attempt-id", "a_1");
    await expect(columns.nth(1)).toHaveAttribute("data-attempt-id", "a_2");
    // a_1 can be chosen: its preview frame at the commit address, its facts, its Choose.
    const first = columns.nth(0);
    await expect(first.locator("iframe")).toHaveAttribute("src", new RegExp(`/pool/${POOL}/c_a1/\\?seed=\\d+$`));
    await expect(first.getByText("Took 42 s")).toBeVisible();
    await expect(first.getByText("Cost $0.12")).toBeVisible();
    await expect(first.getByText("Would send back: 0 changes")).toBeVisible();
    await expect(first.getByRole("button", { name: "Choose" })).toBeEnabled();
    // a_2 still works (3.14 loading row): the state line, no frame, no button.
    const second = columns.nth(1);
    await expect(second.locator("iframe")).toHaveCount(0);
    await expect(second.getByText(/Still working ·/)).toBeVisible();
    // CO39: null seconds and cost read race.unknown — "not recorded", never zero.
    await expect(second.getByText("Took not recorded")).toBeVisible();
    await expect(second.getByText("Cost not recorded")).toBeVisible();
    await expect(second.getByText("Would send back: 1 changes")).toBeVisible();
    await expect(second.getByRole("button", { name: "Choose" })).toHaveCount(0);
  });

  test("CD4/CO38a: Choose sends option choose with the column's attempt_id, the submit_ids and a request_id", async ({
    page,
  }) => {
    const sent: CapturedRequest[] = [];
    await serve(page, RACE_STREAM(raceCard()), { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    // The typed reason goes in `reason` and nowhere else (CO38a).
    await sheet.getByLabel(/Reason/).fill("the faster one");
    await sheet
      .locator('.card-sheet__candidate[data-attempt-id="a_1"]')
      .getByRole("button", { name: "Choose" })
      .click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.url).toContain(`/api/pools/${POOL}/cards/k_r`);
    expect(sent[0]!.body).toMatchObject({
      option: "choose",
      attempt_id: "a_1",
      submit_ids: { a_1: "s_1", a_2: "s_2" },
      reason: "the faster one",
    });
    expect(typeof sent[0]!.body["request_id"]).toBe("string");
  });

  test("3.14 stopped row: card.closed choose reads race.closed; the sheet closes after 1.5 s", async ({ page }) => {
    const wsRef: { ws?: { send: (m: string) => void } } = {};
    await serve(page, RACE_STREAM(raceCard()), { owner: true, wsRef });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet).toBeVisible();
    wsRef.ws!.send(
      JSON.stringify({
        events: [
          ev(50, {
            type: "card.closed",
            card_id: "k_r",
            action: "choose",
            by: "owner",
            attempt_id: "a_1",
            reason: null,
          }),
        ],
      }),
    );
    // race.closed: "The owner chose {changeName}. It lands in the next batch. The others are kept."
    await expect(sheet.getByText(/The owner chose .*\. It lands in the next batch/)).toBeVisible();
    await expect(sheet).toHaveCount(0, { timeout: 6_000 });
  });

  test("3.14 stopped row: card.closed superseded reads race.superseded", async ({ page }) => {
    const wsRef: { ws?: { send: (m: string) => void } } = {};
    await serve(page, RACE_STREAM(raceCard()), { owner: true, wsRef });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet).toBeVisible();
    wsRef.ws!.send(
      JSON.stringify({
        events: [
          ev(50, {
            type: "card.closed",
            card_id: "k_r",
            action: "superseded",
            by: "system",
            attempt_id: null,
            reason: null,
          }),
        ],
      }),
    );
    await expect(sheet.getByText("Every attempt stopped before one was chosen.")).toBeVisible();
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
  });

  test("3.14 held row: a visitor sees the columns but no Choose", async ({ page }) => {
    await serve(page, RACE_STREAM(raceCard()), { owner: false });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.locator(".card-sheet__candidate")).toHaveCount(2);
    await expect(sheet.getByRole("button", { name: "Choose" })).toHaveCount(0);
    await expect(sheet.getByText("Waiting for the owner.")).toBeVisible();
  });

  test("3.14 error row: a choosable candidate without a preview reads held.no_preview", async ({ page }) => {
    const card = raceCard({
      preview: { before: null, after: {}, error: "build failed" },
    });
    await serve(page, RACE_STREAM(card), { owner: true });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    const first = sheet.locator('.card-sheet__candidate[data-attempt-id="a_1"]');
    await expect(first.getByText("No preview is available for this change.")).toBeVisible();
    // Facts and the button stay (3.14 error row).
    await expect(first.getByRole("button", { name: "Choose" })).toBeEnabled();
  });
});
