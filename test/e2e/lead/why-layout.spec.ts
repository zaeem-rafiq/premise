// The Why card's "What it relied on" list (03-floor 3.13): every row's "Who relies on this"
// button sits in one column and keeps its label on one line, also when a premise sentence is
// long enough to wrap ("ENERGY_MAX in world/energy.js (the new code uses it)").

import { expect, test } from "@playwright/test";

for (const size of [
  { name: "stage", width: 1920, height: 1080 },
  { name: "laptop", width: 1440, height: 900 },
]) {
  test(`3.13: the Who relies buttons line up in one column at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/replay/hero-canned");
    await expect(page.locator(".replay-bar")).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 3; i++) await page.keyboard.press(".");
    await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: /Landed/ }).click();
    await page.locator(".landed-row").first().click();
    const buttons = page.locator(".why-sheet .why-relied__who");
    await expect(buttons.first()).toBeVisible();
    const boxes = await buttons.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        // The label's line boxes: one per line it takes (the 44 px target is taller than one line).
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return { right: r.right, left: r.left, lines: tops.size };
      }),
    );
    expect(boxes.length).toBeGreaterThan(2);
    for (const b of boxes) {
      expect(Math.abs(b.right - boxes[0]!.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.left - boxes[0]!.left)).toBeLessThanOrEqual(1);
      expect(b.lines).toBeLessThanOrEqual(1);
    }
  });
}
