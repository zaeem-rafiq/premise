import { expect, test } from "@playwright/test";
import { attempts, headsup, serveReview, ev } from "./review-fixtures.ts";

test("D13 / CO11, VD17: two automatic panels across the rail; manually opened panels stay open", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const send = await serveReview(page, [...attempts(3), headsup(11, "a_1"), headsup(12, "a_2")]);
  await page.goto("/p/testpool");
  const open = page.locator('.headsup__head[aria-expanded="true"]');
  await expect(open).toHaveCount(2);
  send([headsup(13, "a_3")]);
  await expect(open).toHaveCount(2);
  const first = page.locator('[data-attempt-id="a_1"] .headsup__head');
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await first.click();
  await expect(open).toHaveCount(3);
  send([headsup(14, "a_2", 2)]);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(open).toHaveCount(3);
  send([headsup(15, "a_2", 3)]);
  await expect(page.locator('[data-attempt-id="a_2"] .headsup__head[aria-expanded="true"]')).toHaveCount(2);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(open).toHaveCount(3);
});

test("D13 / CO11: unrelated events do not reopen a card the owner collapsed", async ({ page }) => {
  const send = await serveReview(page, [...attempts(1), headsup(5)]);
  await page.goto("/p/testpool");
  const card = page.locator('[data-attempt-id="a_1"]');
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await card.locator(".attempt-card__intent").click();
  await expect(card).toHaveAttribute("aria-expanded", "false");
  send([
    ev(6, {
      type: "attempt.step",
      attempt_id: "a_1",
      step: 1,
      tool: null,
      target: null,
      ok: true,
      error: null,
      ms: 1,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
    }),
  ]);
  // The elapsed step itself confirms the event was applied before the collapsed assertion.
  await expect(card.locator(".attempt-card__line4")).toContainText("Thinking");
  await expect(card).toHaveAttribute("aria-expanded", "false");
  send([headsup(7, "a_1", 2)]);
  await expect(card).toHaveAttribute("aria-expanded", "true");
});
