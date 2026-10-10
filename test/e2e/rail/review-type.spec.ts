import { expect, test } from "@playwright/test";
import { attempts, headsup, serveReview } from "./review-fixtures.ts";

for (const size of [
  { width: 1920, height: 1080, intent: 30, status: 22 },
  { width: 1440, height: 900, intent: 24, status: 18 },
]) {
  for (const theme of ["dark", "light"]) {
    test(`D4 / VD15, 6.2: compact Intent and Status roles at ${size.width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await page.addInitScript((theme) => localStorage.setItem("premise.theme", theme), theme);
      await serveReview(page, [...attempts(6), headsup(20)]);
      await page.goto("/p/testpool");
      const card = page.locator('[data-attempt-id="a_1"]');
      await expect(card.locator(".attempt-card__intent")).toHaveCSS("font-size", `${size.intent}px`);
      await expect(card.locator(".attempt-card__word")).toHaveCSS("font-size", `${size.status}px`);
      await expect(card.locator(".headsup-code__text").first()).toHaveCSS("font-size", `${size.status}px`);
      await page.screenshot({ path: info.outputPath("rail-type.png") });
    });
  }
}
