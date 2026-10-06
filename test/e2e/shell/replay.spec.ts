// Track 1F acceptance: `npm run dev:floor`, then `/replay/tracer` plays the fixture under
// the REPLAY banner with no Worker running (RY3, RY18). AC6: Replay makes only the
// requests of RY1 — `/floor.json`, the recordings, the page's assets; no /api request and
// no WebSocket (RY4). The fixture project of playwright.config.ts serves the built Floor
// with no API, so every request the page makes is visible here.

import { expect, test } from "@playwright/test";

test.describe("/replay/tracer with no Worker running", () => {
  test("acceptance 1F / RY3 / RY18: the fixture plays under the REPLAY banner", async ({ page }) => {
    const requests: string[] = [];
    const sockets: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("websocket", (socket) => sockets.push(socket.url()));

    await page.goto("/replay/tracer");

    // RY3: the REPLAY banner is on from loading through closure.
    const banner = page.locator('.banner[data-tone="replay"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("REPLAY");
    await expect(banner).toContainText("tracer");

    // RY18: a direct link loads and plays - the position moves.
    const position = page.locator(".replay-position");
    await expect(position).toBeVisible();
    const first = await position.textContent();
    await expect(async () => {
      expect(await position.textContent()).not.toBe(first);
    }).toPass({ timeout: 10_000 });

    // The same Floor draws the recording: the rail shows the fixture's request.
    await expect(page.locator(".rail")).toContainText("draw tracer fish");

    // RY19: at the end the bar says so, with Watch again and Open the live Floor.
    await expect(page.locator(".replay-ended")).toContainText("The recording has ended.", {
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Watch again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open the live Floor" })).toBeVisible();
    await expect(banner).toBeVisible(); // still REPLAY at closure

    // AC6 / RY1 / RY4: only the page, /floor.json and recordings were fetched; no WebSocket.
    const api = requests.filter((url) => new URL(url).pathname.startsWith("/api/"));
    expect(api, `Replay asked the API: ${api.join(", ")}`).toEqual([]);
    expect(sockets, `Replay opened a WebSocket: ${sockets.join(", ")}`).toEqual([]);
  });

  test("AC11: with reduced motion the recording starts paused", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/replay/tracer");
    await expect(page.locator(".replay-bar").getByRole("button", { name: "Play", exact: true })).toBeVisible();
  });

  test("the Working tab's empty rail reads rail.empty.working.replay (5.4)", async ({ page }) => {
    // With reduced motion the recording opens paused at its first event (RY18), where
    // nothing is in flight yet - the Working tab's empty text is the recording's own
    // sentence, never the owner's and never the visitor's live one (5.4).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/replay/tracer");
    await expect(page.locator(".rail")).toBeVisible();
    const empty = page.locator(".rail-empty");
    await expect(empty).toHaveText("No change is in flight at this point of the recording.");
    await expect(empty).not.toContainText("Type a request above");
    await expect(empty).not.toContainText("Press Replay to watch a recorded run");
  });
});
