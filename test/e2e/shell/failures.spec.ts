// AC15: the failure rows of 03-floor section 7 that are the shell's, each driven by a
// stream built in the test (FA1) - the banners, the strip, the connection state, the
// missing-pool page and the request failures of the shell's own controls. Each test
// checks the sentence the row names and saves one screenshot per theme under
// test-results/.

import { expect, test, type Page } from "@playwright/test";
import {
  FLOOR_JSON,
  POOL,
  attemptOpened,
  attemptState,
  cardOpened,
  choiceCard,
  ev,
  intentCreated,
  limits,
  metrics,
  poolPaused,
  poolState,
  serveSession,
  serveStream,
} from "./stream.ts";

/** One screenshot per theme under test-results/ (AC15): the current (dark) theme, then
 * the light theme, then back. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `test-results/${name}-dark.png` });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({ path: `test-results/${name}-light.png` });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
}

const BASE = [poolState(1), intentCreated(2), attemptOpened(3)];

test.describe("AC15: the shell's failure rows (section 7)", () => {
  test("FR4: an attempt that stops shows the 5.8 sentence as a toast", async ({ page }) => {
    await serveStream(page, [
      ...BASE,
      attemptState(4, "a_1", "opened", "working"),
      attemptState(5, "a_1", "working", "stopped", { reason: "budget" }),
    ]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".toast")).toContainText(
      "Stopped: it used up its budget of steps or tokens. Its work so far is kept.",
    );
    await shoot(page, "ac15-fr04");
  });

  test("FR5: a push retry draws no banner; accepted changes stay 'Landing…'", async ({ page }) => {
    // The retry is fresh (its ts is now), so it is not yet stalled (4.4 pushStalled).
    const now = Date.now();
    await serveStream(page, [
      ...BASE,
      attemptState(4, "a_1", "opened", "working"),
      ev(5, {
        type: "submit.result",
        attempt_id: "a_1",
        submit_id: "s_1",
        status: "validated",
        tier: "auto",
        checks: [],
        duplicate: false,
      }),
      attemptState(6, "a_1", "working", "validated"),
      ev(7, {
        type: "landing.accepted",
        seq: 1,
        batch_id: 1,
        kind: "change",
        attempt_id: "a_1",
        change_id: "c_a_1",
        intent_id: "i_1",
        request_id: null,
        paths: ["creatures/fish.js"],
        writes: [],
        ts: now,
        t: now,
      }),
      attemptState(8, "a_1", "validated", "accepted", { ts: now, t: now }),
      ev(9, { type: "push.retry", batch_id: 1, tries: 1, error: "timeout", next_try_ms: 5000, ts: now, t: now }),
    ]);
    await page.goto(`/p/${POOL}`);
    await page.waitForTimeout(400);
    // FR5: no banner yet - the push only just started to retry.
    await expect(page.locator(".banner")).toHaveCount(0);
    // The card of the pending landing keeps "Landing…" (FL3: not "Landed").
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await expect(card.getByText("Landing…")).toBeVisible();
    await shoot(page, "ac15-fr05");
  });

  test("FR6: a stalled push draws banner.push and the backlog sub-line", async ({ page }) => {
    await serveStream(page, [
      ...BASE,
      ev(4, { type: "push.retry", batch_id: 1, tries: 2, error: "timeout", next_try_ms: 1000 }),
      metrics(5, { waiting_behind: 2, push_backlog: 3 }),
    ]);
    await page.goto(`/p/${POOL}`);
    const banner = page.locator(".banner[data-tone='confirm']").first();
    await expect(banner).toContainText("PUSH PENDING");
    await expect(banner).toContainText("has not been confirmed yet");
    await expect(page.locator(".strip")).toContainText("3 waiting for a push");
    await shoot(page, "ac15-fr06");
  });

  test("FR7: spend near the cap reads in the confirm tone with spend.near", async ({ page }) => {
    await serveStream(page, [...BASE, limits(4, { spend: 33, cap: 40 })]);
    await page.goto(`/p/${POOL}`);
    const spend = page.locator(".strip-cell[data-tone='confirm']", { hasText: "Spend" });
    await expect(spend).toContainText("$33.00 of $40.00");
    await expect(spend).toContainText("Spend is near the cap.");
    await shoot(page, "ac15-fr07");
  });

  test("FR8: the cap reached shows banner.cap and spend.reached", async ({ page }) => {
    await serveStream(page, [...BASE, limits(4, { spend: 40, cap: 40, refusing: true })]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".banner[data-tone='changed']")).toContainText(
      "The spend cap of $40.00 is reached. No model call starts. Checked changes still land.",
    );
    const spend = page.locator(".strip-cell[data-tone='changed']", { hasText: "Spend" });
    await expect(spend).toContainText("The spend cap is reached.");
    await shoot(page, "ac15-fr08");
  });

  test("FR9: the kill switch is on - banner.killed", async ({ page }) => {
    await serveStream(page, [...BASE, limits(4, { spend: 1, cap: 40, killed: true })]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".banner[data-tone='changed']")).toContainText(
      "The kill switch is on. No model call starts. Checked changes still land.",
    );
    await shoot(page, "ac15-fr09");
  });

  test("FR10: the connection is lost - banner.offline, dimmed, owner controls off", async ({
    page,
  }) => {
    let first = true;
    await page.route("**/floor.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
    );
    await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
      ws.onMessage((message) => {
        const request = JSON.parse(message.toString()) as { hello?: number };
        if (request.hello !== 1) return;
        if (first) {
          first = false;
          ws.send(JSON.stringify({ events: BASE }));
          setTimeout(() => ws.close(), 300);
        } else {
          ws.close();
        }
      });
    });
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await expect(page.getByRole("button", { name: "Stop all agents" })).toBeVisible();

    // The socket dies and every reconnect dies too: after OFFLINE_AFTER_MS the banner,
    // the dimmed page (CO3) and the owner controls off (FR10).
    const banner = page.locator(".banner[data-tone='confirm']", { hasText: "CONNECTION" });
    await expect(banner).toContainText("The connection to the pool is lost. Reconnecting", {
      timeout: 15_000,
    });
    await expect(page.locator(".floor")).toHaveAttribute("data-state", "offline");
    const dimmed = await page.locator(".strip").evaluate((el) => getComputedStyle(el).opacity);
    expect(dimmed).toBe("0.6");
    await expect(page.locator(".strip-stale")).toContainText("As of");
    await expect(page.getByRole("button", { name: "Stop all agents" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Owner", exact: true })).toBeDisabled();
    await shoot(page, "ac15-fr10");
  });

  test("FR11: push_rejected pauses the pool; the owner gets the Rebuild button", async ({ page }) => {
    await serveStream(page, [...BASE, poolPaused(4, "push_rejected")]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    const banner = page.locator(".banner[data-tone='changed']").first();
    await expect(banner).toContainText("Artifacts refused the same push");
    await expect(banner.getByRole("button", { name: "Rebuild from Artifacts" })).toBeVisible();
    await shoot(page, "ac15-fr11");
  });

  test("FR12: a note mismatch pauses with banner.paused.note_seq_mismatch", async ({ page }) => {
    await serveStream(page, [...BASE, poolPaused(4, "note_seq_mismatch")]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".banner[data-tone='changed']")).toContainText(
      "A git note does not match its commit. Nothing lands. The owner must look at the repository.",
    );
    await shoot(page, "ac15-fr12");
  });

  test("FR13: the owner paused landings - banner.paused.owner with kill.allow", async ({ page }) => {
    await serveStream(page, [...BASE, poolPaused(4, "owner")]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    const banner = page.locator(".banner[data-tone='changed']").first();
    await expect(banner).toContainText("The owner paused landings.");
    await expect(banner.getByRole("button", { name: "Allow agents again" })).toBeVisible();
    await shoot(page, "ac15-fr13");
  });

  test("FR14: rebuilding shows banner.rebuilding with progress", async ({ page }) => {
    await serveStream(page, [
      poolState(1),
      intentCreated(2),
      attemptOpened(3),
      poolState(4, { state: "rebuilding", rebuild: { done: 3, total: 9 } }),
    ]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".banner[data-tone='confirm']")).toContainText(
      "Trunk is rebuilding its index (3 of 9).",
    );
    await shoot(page, "ac15-fr14");
  });

  test("FR16: a go-around-limit card raises the Needs-you badge and a tray row", async ({ page }) => {
    await serveStream(page, [
      ...BASE,
      cardOpened(4, choiceCard("card_1", "go_around_limit", "The change was sent back too often.")),
    ]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await expect(page.getByRole("button", { name: "Needs you 1" })).toBeVisible();
    await expect(page.locator(".tray-row")).toContainText("The change was sent back too often.");
    await shoot(page, "ac15-fr16");
  });

  test("FR17: a contradiction card raises the Needs-you badge and a tray row", async ({ page }) => {
    await serveStream(page, [
      ...BASE,
      cardOpened(4, choiceCard("card_1", "contradiction", "Two requests change the same thing.")),
    ]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await expect(page.getByRole("button", { name: "Needs you 1" })).toBeVisible();
    await expect(page.locator(".tray-row")).toContainText("Two requests change the same thing.");
    await shoot(page, "ac15-fr17");
  });

  test("FR21: the owner session ended - owner.expired toast, Visitor header, dialog opens", async ({
    page,
  }) => {
    await serveStream(page, BASE);
    await serveSession(page, true);
    await page.route("**/api/kill", (route) => route.fulfill({ status: 401, body: "{}" }));
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "Stop all agents" }).click();
    await page.locator(".kill-sheet").getByRole("button", { name: "Stop all agents" }).click();
    await expect(page.locator(".toast")).toContainText("Your owner session has ended.");
    await expect(page.getByRole("button", { name: "Visitor" })).toBeVisible();
    await expect(page.locator(".owner-sheet")).toBeVisible();
    await shoot(page, "ac15-fr21");
  });

  test("FR22: a refused request shows the 5.9 sentence next to the control and as a toast", async ({
    page,
  }) => {
    await serveStream(page, BASE);
    await serveSession(page, true);
    await page.route("**/api/kill", (route) => route.fulfill({ status: 429, body: "{}" }));
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "Stop all agents" }).click();
    const dialog = page.locator(".kill-sheet");
    await dialog.getByRole("button", { name: "Stop all agents" }).click();
    await expect(dialog.locator(".field-error")).toContainText(
      "Too many requests. Wait a moment, then try again.",
    );
    await expect(page.locator(".toast")).toContainText("Too many requests.");
    await shoot(page, "ac15-fr22");
  });

  test("FR26: all slots busy - the strip reads the limit and the intent box explains", async ({
    page,
  }) => {
    await serveStream(page, [
      poolState(1, { real_agents: 6, max_real_agents: 6 }),
      intentCreated(2),
      attemptOpened(3), // state "opened" while every slot is busy
    ]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".strip")).toContainText("6 of 6");
    await expect(page.locator(".intent-box")).toContainText(
      "All 6 agent slots are busy. Your request waits for a free slot.",
    );
    await shoot(page, "ac15-fr26");
  });

  test("FR27: an unknown event is counted in About and nothing else changes", async ({ page }) => {
    await serveStream(page, [
      ...BASE,
      ev(4, { type: "future.invented", anything: "goes" }),
    ]);
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "About" }).click();
    await expect(page.locator(".sheet")).toContainText(
      "This page skipped 1 events of a newer kind. Reload to get the newest page.",
    );
    await expect(page.locator(".strip")).toBeVisible();
    await shoot(page, "ac15-fr27");
  });

  test("FR30: an unknown pool shows pool.missing with the way to the default pool", async ({
    page,
  }) => {
    await page.route("**/api/pools/ghost/stream", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }),
    );
    await page.goto("/p/ghost");
    const missing = page.getByTestId("pool-missing");
    await expect(missing).toContainText("There is no pool at this address.");
    await expect(missing.getByRole("button", { name: "Open the default pool" })).toBeVisible();
    // The header stays (FR30).
    await expect(page.locator(".header")).toBeVisible();
    await shoot(page, "ac15-fr30");
  });
});
