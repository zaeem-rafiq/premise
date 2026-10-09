import { expect, test } from "@playwright/test";
import { poolState, serveReview } from "./review-fixtures.ts";

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test(`D26 / 3.1, 2.1: intent controls keep whole single-line labels at ${size.width}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    await serveReview(page, [poolState(1)], {
      prewritten: Array.from({ length: 6 }, (_, i) => ({
        id: `A0${i + 1}`,
        text: `a creature ${i + 1}`,
        group: "starter",
        race: false,
      })),
    });
    await page.goto("/p/testpool");
    const row = page.locator(".intent-row");
    await expect(row.getByRole("button", { name: "Send the starter set (6)" })).toBeVisible();
    for (const label of await row.locator("button, .intent-count").all()) {
      expect(
        await label.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        }),
      ).toBe(1);
    }
    const menu = row.locator("select");
    expect(
      await menu.evaluate((el) => {
        const style = getComputedStyle(el);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        ctx.font = `${style.fontSize} ${style.fontFamily}`;
        return (
          el.clientWidth >=
          ctx.measureText("Pre-written requests").width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            24
        );
      }),
    ).toBe(true);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("intent-labels.png") });
  });
}
