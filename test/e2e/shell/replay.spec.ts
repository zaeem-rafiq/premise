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

  test("RY19: at its end the bar holds its controls, its track and its marks", async ({ page }) => {
    // At stage (1920x1080) and laptop (1440x900): once the recording has ended the bar
    // shows replay.ended, Watch again and Open the live Floor without squeezing the rest
    // - the track keeps at least half the bar's width, no text is cut off, the chapter
    // marks do not overlap, and the page does not scroll sideways.
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/replay/tracer");
      const bar = page.locator(".replay-bar");
      await expect(bar).toBeVisible();

      // End on the slider seeks to the recording's last event.
      await page.locator(".replay-track").press("End");
      const ended = page.locator(".replay-ended");
      await expect(ended).toContainText("The recording has ended.");
      await expect(ended.getByRole("button", { name: "Watch again" })).toBeVisible();
      await expect(ended.getByRole("button", { name: "Open the live Floor" })).toBeVisible();

      const barBox = await bar.boundingBox();
      const trackBox = await page.locator(".replay-track-wrap").boundingBox();
      expect(barBox, `${viewport.width}px: the bar has a box`).not.toBeNull();
      expect(trackBox, `${viewport.width}px: the track has a box`).not.toBeNull();
      expect(trackBox!.width, `${viewport.width}px: the track keeps at least half the bar`).toBeGreaterThanOrEqual(
        barBox!.width / 2,
      );

      // No text element in the bar is clipped.
      const clipped = await bar
        .locator(".replay-ended, .replay-ended button, .replay-position")
        .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
      expect(clipped, `${viewport.width}px: clipped text elements`).toEqual([]);

      // No two chapter marks overlap.
      const marks = await page
        .locator(".replay-mark")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
      marks.sort((a, b) => a.left - b.left);
      for (let i = 1; i < marks.length; i++) {
        expect(marks[i]!.left, `${viewport.width}px: mark ${i} clears the mark before it`).toBeGreaterThanOrEqual(
          marks[i - 1]!.right - 0.5,
        );
      }

      // The bar does not push the page sideways.
      const pageFits = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      );
      expect(pageFits, `${viewport.width}px: no horizontal page scroll`).toBe(true);
    }
  });
});
