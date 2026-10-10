// The risk block of the held sheet (03-floor 5.10, FR18; 01-core 10.4, RK1, RK5): while Clef has
// not answered the sheet says so; a `card.updated` with `Card.risk` fills the three lines with
// whole percents and the footer; an answer that is null reads "not available"; `risk.error`
// shows `held.risk_unavailable`. Expected text is 5.10's tables and the copy entries, never the
// page's own output (BP1).

import { expect, test, type Page } from "@playwright/test";
import {
  attemptOpened,
  attemptState,
  ev,
  FLOOR_JSON,
  intentCreated,
  poolState,
  POOL,
  serveSession,
} from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

const WAITING = "Clef's answers are on their way. You can decide without them.";
const UNAVAILABLE = "Clef's answers are not available. Decide from the preview and the checks.";
const FOOTER = "Judged by Clef (clef). These numbers inform you. They never land or decline a change.";

function heldCard(risk: Frame | null): Frame {
  return {
    card_id: "k_1",
    kind: "held",
    attempt_ids: ["a_1"],
    intent_ids: ["i_1"],
    submit_ids: { a_1: "s_1" },
    title: "This change touches shared rules. Land it?",
    body: ["It changes world/movement.js."],
    options: [
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ],
    paths: [{ path: "world/movement.js", tier: "held" }],
    blast_radius: { a_1: { repair: [], confirm: [], triage: [], right_of_way: [] } },
    preview: null,
    candidates: null,
    risk,
    reason: "held_path",
  };
}

const STREAM = (risk: Frame | null): Frame[] => [
  poolState(1),
  intentCreated(2, "i_1", "let creatures move faster"),
  attemptOpened(3),
  attemptState(4, "a_1", "opened", "working"),
  ev(5, {
    type: "submit.result",
    attempt_id: "a_1",
    submit_id: "s_1",
    status: "held",
    tier: "held",
    checks: [{ name: "typecheck", ok: true }],
    duplicate: false,
  }),
  attemptState(6, "a_1", "working", "held", { reason: "held_path" }),
  ev(7, { type: "card.opened", card: heldCard(risk) }),
];

async function serve(page: Page, frames: Frame[], wsRef: { ws?: { send(m: string): void } } = {}): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await serveSession(page, true);
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    wsRef.ws = ws;
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
}

async function openSheet(page: Page) {
  await page.goto(`/p/${POOL}`);
  await page.locator(".tray").getByRole("button", { name: "Open" }).click();
  const sheet = page.getByRole("dialog", { name: "This change touches shared rules. Land it?" });
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe("the held sheet's risk lines (5.10, RK1)", () => {
  test("RK5: the sheet waits for Clef, then card.updated fills the three lines and the footer", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const wsRef: { ws?: { send(m: string): void } } = {};
    await serve(page, STREAM(null), wsRef);
    const sheet = await openSheet(page);
    const block = sheet.locator(".card-sheet__risk");
    await expect(block).toHaveText(WAITING);
    const risk = { model: "clef", does_what_asked: 0.92, changes_shared_meaning: 0.81, unrelated_edits: 0.07 };
    wsRef.ws?.send(JSON.stringify({ events: [ev(8, { type: "card.updated", card: heldCard(risk) })] }));
    await expect(block.locator("p")).toHaveText([
      "Does what was asked: 92%",
      "Changes the meaning of shared code: 81%",
      "Includes edits nobody asked for: 7%",
      FOOTER,
    ]);
    await sheet.screenshot({ path: testInfo.outputPath("held-sheet-risk-lines.png") });
    expect(errors).toEqual([]);
  });

  test("5.10: an answer that is null reads 'not available'", async ({ page }) => {
    await serve(
      page,
      STREAM({ model: "clef", does_what_asked: 0.5, changes_shared_meaning: null, unrelated_edits: 0.31 }),
    );
    const sheet = await openSheet(page);
    await expect(sheet.locator(".card-sheet__risk p")).toHaveText([
      "Does what was asked: 50%",
      "Changes the meaning of shared code: not available",
      "Includes edits nobody asked for: 31%",
      FOOTER,
    ]);
  });

  test("FR18/RK3: risk.error shows held.risk_unavailable and no lines", async ({ page }) => {
    await serve(
      page,
      STREAM({
        model: "clef",
        does_what_asked: null,
        changes_shared_meaning: null,
        unrelated_edits: null,
        error: "timeout",
      }),
    );
    const sheet = await openSheet(page);
    await expect(sheet.locator(".card-sheet__risk")).toHaveText(UNAVAILABLE);
  });
});
