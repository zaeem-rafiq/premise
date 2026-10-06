// The held-change sheet of 03-floor 3.13 (plan 2.6 item 5): the two commit frames of CO36/PV5 at
// their `frameUrl` addresses, the state-table sentences (`held.preview_building`, `held.no_preview`
// of FR32, `held.stale` of FR15), the blast/risk blocks and the card's own options (CD4/CD5, AC22 —
// `land_now` only while the card offers it, CO35a). Requests are routed and asserted (4.5). Expected
// values come from the spec's copy tables, never from the page (BP1).

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

/** The fake pool host: a document the commit iframes can load; `__tap` posts CO22's `tapped`. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__tap = function (path) {
    parent.postMessage({ type: "tapped", creature: "crab", path: path }, "*");
  };
  parent.postMessage({ type: "stats", source: location.pathname.split("/")[3], version: "c-1",
    seq: 1, tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
</script>`;

function premiseRecorded(n: number, attemptId = "a_1"): Frame {
  return ev(n, {
    type: "premise.recorded",
    attempt_id: attemptId,
    tool: "replace",
    premise: { kind: "file", key: "world/energy.js", hash: "h-e0", seq: 0, read: true, edit: true, derived: false },
  });
}

function submit(n: number, attemptId = "a_1", submitId = "s_1"): Frame {
  return ev(n, {
    type: "submit.result",
    attempt_id: attemptId,
    submit_id: submitId,
    status: "held",
    tier: "held",
    checks: [{ name: "typecheck", ok: true }],
    duplicate: false,
  });
}

/** A `card.opened` frame; `card` is the `Card` of 01-core 10.3. */
function cardOpened(n: number, card: Frame): Frame {
  return ev(n, { type: "card.opened", card });
}

/** The held card with both commit-frame addresses (CO36) and the `land_now` option of CO35a. */
function heldCard(over: Frame = {}): Frame {
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
    blast_radius: { a_1: { repair: [], confirm: [], triage: [], right_of_way: [] } },
    preview: {
      before: { repo: "main", commit: "c_before" },
      after: { a_1: { repo: "main", commit: "c_after" } },
      error: null,
    },
    candidates: null,
    risk: null,
    reason: "held_path",
    ...over,
  };
}

const HELD_STREAM = (card: Frame) => [
  poolState(1),
  intentCreated(2),
  attemptOpened(3),
  attemptState(4, "a_1", "opened", "working"),
  premiseRecorded(5),
  submit(6),
  attemptState(7, "a_1", "working", "held", { reason: "held_path" }),
  cardOpened(8, card),
];

type CapturedRequest = { url: string; body: Record<string, unknown> };

/**
 * The floor.json/session/stream routes plus the commit iframes' `/pool/**` pages and the captured
 * card-action POST. `wsRef` keeps the live socket so a test can push a late `card.closed`.
 */
async function serve(
  page: Page,
  frames: Frame[],
  opts: {
    owner?: boolean;
    floorJson?: Frame;
    holdMs?: number;
    sent?: CapturedRequest[];
    wsRef?: { ws?: { send: (m: string) => void } };
  } = {},
): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(opts.floorJson ?? FLOOR_JSON) }),
  );
  await serveSession(page, opts.owner === true);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  const answer = async (route: Route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    opts.sent?.push({ url: route.request().url(), body });
    if (opts.holdMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.holdMs));
    await route.fulfill({ contentType: "application/json", body: "{}" });
  };
  await page.route("**/api/pools/*/cards/*", answer);
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    opts.wsRef && (opts.wsRef.ws = ws);
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
}

test.describe("the held sheet (3.13)", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`CO14: dense held lights stay inside their column at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const frames = [
        poolState(1),
        intentCreated(2, "i_1", "raise the crab's energy"),
        attemptOpened(3),
        attemptState(4, "a_1", "opened", "working"),
      ];
      const premises = densePremises(5, "a_1", 2);
      frames.push(...premises);
      let n = 5 + premises.length;
      frames.push(
        submit(n++),
        attemptState(n++, "a_1", "working", "held", { reason: "held_path" }),
        cardOpened(n, heldCard()),
      );
      await serve(page, frames, { owner: true });
      await page.goto(`/p/${POOL}`);
      await page.locator(".tray").getByRole("button", { name: "Open" }).click();
      const sheet = page.getByRole("dialog", { name: "This change touches shared rules. Land it?" });
      await expect(sheet).toBeVisible();
      const checked = sheet
        .locator(".card-sheet__grid > section")
        .filter({ has: page.getByRole("heading", { name: "What was checked" }) });
      await expectLightsInsideColumn(checked, 18, 2);
      await expectNoSheetOverflow(sheet);
      await sheet.screenshot({ path: testInfo.outputPath("held-sheet-lights.png") });
      expect(errors).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    });
  }

  test("CO36/PV5: before and after are commit iframes at their frameUrl addresses", async ({ page }) => {
    await serve(page, HELD_STREAM(heldCard()), { owner: true });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("Before: the pool now")).toBeVisible();
    await expect(sheet.getByText("After: the pool with this change")).toBeVisible();
    const frames = sheet.locator(".sheet-frame__body iframe");
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(0)).toHaveAttribute("src", new RegExp(`/pool/${POOL}/c_before/\\?seed=\\d+$`));
    await expect(frames.nth(1)).toHaveAttribute("src", new RegExp(`/pool/${POOL}/c_after/\\?seed=\\d+$`));
  });

  test("3.13, AC22: the sheet shows the card's text and options; Land sends the typed reason, submit_ids and request_id (CO35)", async ({
    page,
  }) => {
    const sent: CapturedRequest[] = [];
    await serve(page, HELD_STREAM(heldCard()), { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("This change touches shared rules. Land it?")).toBeVisible();
    await expect(sheet.getByText("It changes world/energy.js.")).toBeVisible();
    await expect(sheet.getByText('owner: "a tracer fish"')).toBeVisible();
    await expect(sheet.getByText("What it changes")).toBeVisible();
    await expect(sheet.getByText("What was checked")).toBeVisible();
    const buttons = sheet.locator(".card-sheet__actions button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText("Decline");
    await expect(buttons.nth(1)).toHaveText("Land");
    // The typed reason goes in `reason` and nowhere else (CO35).
    await sheet.getByLabel(/Reason/).fill("it is small");
    await buttons.nth(1).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.url).toContain(`/api/pools/${POOL}/cards/k_1`);
    expect(sent[0]!.body).toMatchObject({
      option: "land",
      submit_ids: { a_1: "s_1" },
      reason: "it is small",
    });
    expect(typeof sent[0]!.body["request_id"]).toBe("string");
    expect(sent[0]!.body["attempt_id"]).toBeUndefined();
  });

  test("CO35a: 'Land now' shows only while the card offers land_now, with held.land_now.tip", async ({ page }) => {
    const card = heldCard({
      options: [
        { id: "land", label: "Land" },
        { id: "land_now", label: "Land now" },
        { id: "decline", label: "Decline" },
      ],
      blast_radius: { a_1: { repair: [], confirm: [], triage: [], right_of_way: ["a_9"] } },
    });
    const sent: CapturedRequest[] = [];
    // The right-of-way attempt is in flight, so the blast sentence names it (CO35a).
    const stream = [
      poolState(1),
      intentCreated(2),
      attemptOpened(3),
      ev(4, {
        type: "intent.created",
        intent_id: "i_9",
        text: "the other fish",
        requester: "owner",
        race: false,
        prewritten: false,
      }),
      attemptOpened(5, "a_9", "i_9"),
      attemptState(6, "a_9", "opened", "working"),
      attemptState(7, "a_1", "opened", "working"),
      premiseRecorded(8),
      submit(9),
      attemptState(10, "a_1", "working", "held", { reason: "held_path" }),
      cardOpened(11, card),
    ];
    await serve(page, stream, { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    const buttons = sheet.locator(".card-sheet__actions button");
    await expect(buttons).toHaveCount(3);
    // Options in the card's order, the first (Land) primary at the right.
    await expect(buttons.nth(0)).toHaveText("Land now");
    await expect(buttons.nth(0)).toHaveAttribute("title", /Lands it in the next batch/);
    await expect(buttons.nth(1)).toHaveText("Decline");
    await expect(buttons.nth(2)).toHaveText("Land");
    // The blast line names the right-of-way sentence of 5.10.
    await expect(sheet.getByText("Who it affects")).toBeVisible();
    await expect(sheet.getByText(/Landing this sends .* around again/)).toBeVisible();
    await buttons.nth(0).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.body["option"]).toBe("land_now");
  });

  test("FR32: preview.error reads held.no_preview in the after frame only; the before frame still plays; the buttons stay enabled", async ({
    page,
  }) => {
    const sent: CapturedRequest[] = [];
    // PV2: `before` is the commit of main when the card opened — it stays even when the preview
    // build fails (PV3 empties `after` and sets `error`). FR32's sentence is the after frame's.
    const card = heldCard({
      preview: { before: { repo: "main", commit: "c_before" }, after: {}, error: "build failed" },
    });
    await serve(page, HELD_STREAM(card), { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    // Strict mode: the sentence appears exactly once, in the after cell.
    await expect(sheet.getByText("No preview is available for this change.")).toBeVisible();
    const frames = sheet.locator(".sheet-frame__body iframe");
    await expect(frames).toHaveCount(1);
    await expect(frames.nth(0)).toHaveAttribute("src", new RegExp(`/pool/${POOL}/c_before/\\?seed=\\d+$`));
    await sheet.locator(".card-sheet__actions").getByRole("button", { name: "Decline" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.body["option"]).toBe("decline");
  });

  test("3.13 loading row: preview null reads held.preview_building in the after frame", async ({ page }) => {
    const card = heldCard({ preview: null });
    await serve(page, HELD_STREAM(card), { owner: true });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    const notes = sheet.locator(".sheet-frame__note");
    await expect(notes).toHaveCount(2);
    await expect(notes.nth(0)).toHaveText("Building the preview…");
    await expect(notes.nth(1)).toHaveText("Building the preview…");
    await expect(sheet.locator(".card-sheet__actions button").nth(1)).toBeEnabled();
  });

  test("FR15: a stale card shows held.stale, buttons off, and the sheet closes", async ({ page }) => {
    const wsRef: { ws?: { send: (m: string) => void } } = {};
    await serve(page, HELD_STREAM(heldCard()), { owner: true, wsRef });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet).toBeVisible();
    // The card goes out of date: card.closed action stale by the system (3.13 stopped row).
    wsRef.ws!.send(
      JSON.stringify({
        events: [
          ev(50, {
            type: "card.closed",
            card_id: "k_1",
            action: "stale",
            by: "system",
            attempt_id: null,
            reason: null,
          }),
        ],
      }),
    );
    await expect(sheet.getByText(/out of date/)).toBeVisible();
    await expect(sheet.locator(".card-sheet__actions")).toHaveCount(0);
    // The sheet closes after STALE_CARD_MS (6 s).
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
  });

  test("CO37: Esc closes the sheet and sends nothing; Close closes it too", async ({ page }) => {
    const sent: CapturedRequest[] = [];
    await serve(page, HELD_STREAM(heldCard()), { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    expect(sent.length).toBe(0);
    // Reopen and close via the Close button — still no request.
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    expect(sent.length).toBe(0);
  });

  test("3.13 error row: a failed action request keeps the sheet open with the 5.9 sentence", async ({ page }) => {
    const sent: CapturedRequest[] = [];
    await page.route("**/floor.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
    );
    await serveSession(page, true);
    await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
    await page.route("**/api/pools/*/cards/*", async (route) => {
      sent.push({
        url: route.request().url(),
        body: (await route.request().postDataJSON()) as Record<string, unknown>,
      });
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });
    await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
      ws.onMessage((message) => {
        const request = JSON.parse(message.toString()) as { hello?: number };
        if (request.hello === 1) ws.send(JSON.stringify({ events: HELD_STREAM(heldCard()) }));
      });
    });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await sheet.locator(".card-sheet__actions").getByRole("button", { name: "Land" }).click();
    await expect.poll(() => sent.length).toBe(1);
    // The sheet stays open; the request error sentence shows (5.9).
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".card-sheet__error")).toContainText("Try again");
    await expect(sheet.locator(".card-sheet__actions button").nth(1)).toBeEnabled();
  });

  test("3.13 held row: a visitor sees no buttons and held.visitor", async ({ page }) => {
    await serve(page, HELD_STREAM(heldCard()), { owner: false });
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("Waiting for the owner.")).toBeVisible();
    await expect(sheet.locator(".card-sheet__actions")).toHaveCount(0);
    await expect(sheet.getByLabel(/Reason/)).toHaveCount(0);
  });
});
