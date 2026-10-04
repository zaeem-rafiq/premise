// RY16 on the whole page: after a Replay jump the page draws the rebuilt state, not the
// state from before the jump. hero-c04 plays to its end, restarts to its start (key 0,
// paused so the position holds), jumps to the Conflict chapter (key 2) and back to the
// Requests chapter (key 1) - the strip, the rail and the caption follow each time.

import { expect, test, type Page } from "@playwright/test";

function valueOf(page: Page, label: string) {
  return page.locator(".strip-cell", { hasText: label }).locator(".strip-value").innerText();
}

test("a Replay seek rebuilds what the page draws (RY16)", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/replay/hero-c04");
  await expect(page.locator(".rail")).toBeVisible();

  // Play to the end at 8x: two changes landed, one go-around happened.
  await page.keyboard.press(".");
  await page.keyboard.press(".");
  await page.keyboard.press(".");
  await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 20_000 });
  expect((await valueOf(page, "Landed")).trim()).toBe("2");
  expect((await valueOf(page, "Go-arounds")).trim()).toBe("1");
  await expect(page.locator(".tabs")).toContainText("Landed 2");

  // Pause, then key 0 restarts: the counters and cards of the start. Landed and the
  // counters read the dash of an empty stream; nothing is in flight.
  await page.keyboard.press(" ");
  await page.keyboard.press("0");
  expect((await valueOf(page, "Landed")).trim()).toBe("—");
  expect((await valueOf(page, "Real agents")).trim()).toBe("—");
  await expect(page.locator(".rail-list")).toContainText("No change is in flight");
  await expect(page.locator(".tabs")).not.toContainText("Landed 2");

  // Key 2 jumps to the Conflict chapter (3 s before the first headsup.sent): both
  // attempts are still working and nothing has landed.
  await page.keyboard.press("2");
  expect((await valueOf(page, "Landed")).trim()).toBe("0");
  expect((await valueOf(page, "Real agents")).trim()).toBe("1 of 6");
  await expect(page.locator(".rail-list .attempt-card__status").first()).toContainText("Working");

  // Key 1 jumps back to Requests: pool.state alone is applied - the earlier state again.
  await page.keyboard.press("1");
  expect((await valueOf(page, "Landed")).trim()).toBe("0");
  expect((await valueOf(page, "Real agents")).trim()).toBe("1 of 6");
  await expect(page.locator(".rail-list")).toContainText("No change is in flight");
});
