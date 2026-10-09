import { expect, test } from "@playwright/test";
import { attempts, headsup, serveReview } from "./review-fixtures.ts";

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test(`D12 / LY3, CO19: complete heads-up code wraps without horizontal scrolling at ${size.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    await serveReview(page, [...attempts(1), headsup(5)]);
    await page.goto("/p/testpool");
    const code = page.locator(".headsup-code__text");
    await expect(code).toHaveCount(2);
    await expect(code.first()).toContainText("to ENERGY_MAX (full).");
    for (const block of await code.all()) {
      await expect(block).toHaveCSS("white-space", "pre-wrap");
      expect(await block.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await page.locator(".rail-list").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("heads-up-wrapped.png") });
  });
}
