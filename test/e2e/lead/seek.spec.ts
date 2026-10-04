// RY16 on the whole page: after a Replay jump the page draws the rebuilt state, not the
// state from before the jump. hero-c04 plays to its end, restarts to its start (key 0,
// paused so the position holds), jumps to the Conflict chapter (key 2) and back to the
// Requests chapter (key 1) - the strip and the rail follow each time.

import { expect, test, type Page } from "@playwright/test";

function valueOf(page: Page, label: string): Promise<string> {
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

  // Pause, then key 0 restarts. The rebuild applies the first event (pool.state at the
  // zero position): the pool's counts read 0, the tabs and cards of the start.
  await page.keyboard.press(" ");
  await page.keyboard.press("0");
  await expect.poll(() => valueOf(page, "Landed")).toBe("0");
  expect((await valueOf(page, "Real agents")).trim()).toBe("1 of 6");
  expect((await valueOf(page, "Go-arounds")).trim()).toBe("0");
  await expect(page.locator(".rail-list")).toContainText("No change is in flight");
  await expect(page.locator(".tabs")).not.toContainText("Landed 2");

  // Key 2 jumps to the Conflict chapter (3 s before the first headsup.sent): the applied
  // prefix holds both attempts opened and working, nothing yet landed.
  await page.keyboard.press("2");
  await expect(page.locator(".rail-list .attempt-card")).toHaveCount(2);
  await expect.poll(() => valueOf(page, "Landed")).toBe("0");
  await expect(page.locator(".rail-list .attempt-card__status").first()).toContainText("Working");

  // Key 1 jumps back to Requests: the pool.state-only start again.
  await page.keyboard.press("1");
  await expect(page.locator(".rail-list")).toContainText("No change is in flight");
  await expect.poll(() => valueOf(page, "Landed")).toBe("0");
});
