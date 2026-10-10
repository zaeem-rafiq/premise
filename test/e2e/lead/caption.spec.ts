// The pool frame's caption bar (03-floor 2.1, 2.8) stays one row at laptop widths, also when
// reduced motion pauses the picture and adds the paused chip (AC11): the caption keeps a
// readable start, the chip and both buttons stay inside the bar, and nothing wraps.

import { expect, test } from "@playwright/test";

for (const width of [1100, 1280, 1440, 1599]) {
  test(`2.8/AC11: the caption bar is one row with the paused chip at ${width}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/replay/hero-c04");
    const bar = page.locator(".pool-area .pf-caption").first();
    await expect(bar.locator(".pf-chip")).toBeVisible();
    const report = await bar.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const parts = [...el.children].map((child) => {
        const r = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const lines = Math.round((r.height - padding) / line);
        return {
          cls: child.className,
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          lines,
        };
      });
      return { rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, parts };
    });
    const button = report.parts.find((p) => p.cls.includes("pf-btn"))!;
    for (const part of report.parts.filter((p) => p.width > 0)) {
      // One row: every part overlaps the button's row, and none leaves the bar sideways.
      expect(part.top, part.cls).toBeLessThan(button.bottom);
      expect(part.bottom, part.cls).toBeGreaterThan(button.top);
      expect(part.left, part.cls).toBeGreaterThanOrEqual(report.rect.left - 0.5);
      expect(part.right, part.cls).toBeLessThanOrEqual(report.rect.right + 0.5);
      // Text parts are one line; a button's 44 px target (LY5) is taller than its one line.
      if (!part.cls.includes("pf-btn")) expect(part.lines, part.cls).toBeLessThanOrEqual(1);
    }
    const caption = report.parts.find((p) => p.cls.includes("pf-caption-text"))!;
    expect(caption.width).toBeGreaterThanOrEqual(150);
    expect(report.rect.bottom - report.rect.top).toBeLessThanOrEqual(button.bottom - button.top + 1);
  });
}
