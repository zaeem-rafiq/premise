// AC3 / FL3: a stream with `landing.accepted` and no `landing.landed` shows "Landing…",
// leaves the Landed counter unchanged and offers no Why card. In the tracer fixture the
// push waits 2 s between `push.retry` (event 24) and `landing.landed` (event 25); at half
// speed the window is 4 s, enough to read the page inside it.

import { expect, test } from "@playwright/test";

test("AC3 / FL3: accepted is not landed", async ({ page }) => {
  await page.goto("/replay/tracer");
  await expect(page.locator(".replay-bar")).toBeVisible();

  // Slow to 0.5x so the accepted-not-landed window is 4 s.
  await page.keyboard.press(",");
  await expect(page.getByRole("button", { name: "Speed 0.5×" })).toBeVisible();

  // The attempt goes "Landing…" (status.accepted) while the landing is accepted.
  const row = page.locator(".attempt-row", { hasText: "draw tracer fish" });
  await expect(row).toContainText("Landing…", { timeout: 30_000 });

  // In that window the Landed counter has not moved and no landing row offers a Why card.
  const landedCell = page.locator(".strip-cell", { hasText: "Landed" }).first();
  await expect(landedCell).toContainText("0");
  await page.getByRole("tab", { name: /Landed/ }).click();
  const pendingRow = page.locator(".landed-pending", { hasText: "landing 1" });
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow.locator("button")).toHaveCount(0);
  await expect(page.locator(".rail-list button", { hasText: "landing 1" })).toHaveCount(0);

  // Then landing.landed arrives: the row offers the card, the counter moves.
  await expect(page.locator(".landed-row", { hasText: "landing 1" })).toBeVisible({ timeout: 30_000 });
  await expect(landedCell).toContainText("1");
});
