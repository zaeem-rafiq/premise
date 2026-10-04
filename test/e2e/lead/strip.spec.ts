// The strip's cells on the real page (03-floor 3.8, 2.1): no label or value is clipped by
// its cell or runs into the cell's edge, and no label's rendered text ends in an ellipsis.
// Checked at both reference sizes in Replay, where every cell carries its sentence form.

import { expect, test } from "@playwright/test";

const SIZES = [
  { name: "stage", w: 1920, h: 1080 },
  { name: "laptop", w: 1440, h: 900 },
] as const;

for (const size of SIZES) {
  test(`no strip text is clipped or ellipsized at ${size.name} (3.8)`, async ({ page }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.goto("/replay/hero-c04");
    await expect(page.locator(".strip")).toBeVisible();
    await expect(page.locator(".tiles-grid .tile").first()).toBeVisible();

    const report = await page.evaluate(() => {
      const out: Array<{ cell: string; kind: string; rect: string; cellRect: string }> = [];
      for (const cell of document.querySelectorAll<HTMLElement>(".strip-cell")) {
        const cr = cell.getBoundingClientRect();
        const cs = getComputedStyle(cell);
        const padL = parseFloat(cs.paddingLeft);
        const padR = parseFloat(cs.paddingRight);
        const name = cell.querySelector(".strip-label")?.textContent ?? "?";
        for (const el of cell.querySelectorAll<HTMLElement>(
          ".strip-label, .strip-value, .strip-sub",
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const inside =
            r.left >= cr.left + padL - 1 &&
            r.right <= cr.right - padR + 1 &&
            r.top >= cr.top - 0.5 &&
            r.bottom <= cr.bottom + 0.5;
          const clipped = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          if (!inside || clipped) {
            out.push({
              cell: name,
              kind: el.className,
              rect: JSON.stringify(r.toJSON()),
              cellRect: JSON.stringify(cr.toJSON()),
            });
          }
        }
      }
      return out;
    });
    expect(report, JSON.stringify(report, null, 2)).toEqual([]);
  });
}
