import { expect, test } from "@playwright/test";
import { POOL, poolState, serveStream } from "./stream.ts";
for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test(`D30 3.19 5.12: About has seven boxes in three columns at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await serveStream(page, [poolState(1)]);
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "About", exact: true }).click();
    const sheet = page.locator(".about-sheet");
    await expect(sheet).toContainText("Repair time with real agents: median –, p90 –.");
    await expect(sheet).toContainText("Attempt repositories are not provisioned in this build.");
    await expect(sheet.locator(".about-box")).toHaveCount(7);
    // D34 FL5: rule ids are not part of the visible key instructions.
    await expect(sheet.locator(".shortcut-table")).not.toContainText("RY26");
    expect(
      await sheet
        .locator(".about-box")
        .evaluateAll((boxes) => boxes.every((box) => Number.parseFloat(getComputedStyle(box).borderTopWidth) >= 1)),
    ).toBe(true);
    expect(
      await sheet
        .locator(".about-columns")
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
    ).toBe(3);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  });
}
