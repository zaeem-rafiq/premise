// The strip's cells on the real page (03-floor 3.8, 2.1): no label or value is clipped by
// its cell or runs into the cell's edge, and no label's rendered text ends in an ellipsis.
// Checked at both reference sizes in Replay, where every cell carries its sentence form.

import { expect, test } from "@playwright/test";

const SIZES = [
  { name: "stage", w: 1920, h: 1080 },
  { name: "laptop", w: 1440, h: 900 },
  // 2.8's range starts at 1100: the narrowest laptop windows (design review, still open after VE8).
  { name: "laptop-1280", w: 1280, h: 800 },
  { name: "laptop-1100", w: 1100, h: 720 },
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
        for (const el of cell.querySelectorAll<HTMLElement>(".strip-label, .strip-value, .strip-sub")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          // A counter is drawn on a 0.8 line (6.2): its inline box is taller than the line it
          // sits on, and the empty part above and below the figures may pass the cell's edge
          // without hiding anything. Its line, centred in that box, must be inside the cell.
          const cs2 = getComputedStyle(el);
          const line = cs2.display === "inline" ? Math.min(r.height, parseFloat(cs2.lineHeight) || r.height) : r.height;
          const top = r.top + (r.height - line) / 2;
          const inside =
            r.left >= cr.left + padL - 1 &&
            r.right <= cr.right - padR + 1 &&
            top >= cr.top - 0.5 &&
            top + line <= cr.bottom + 0.5;
          // Below 1280 the agents cell's limit line may end in an ellipsis, as at stage below
          // about 1710 (base.css 2.2/2.8): the one sentence that gives way when seven cells do not fit.
          const mayEllipsize =
            window.innerWidth < 1280 && cell.dataset["cell"] === "strip.agents" && el.classList.contains("strip-sub");
          const clipped =
            !mayEllipsize && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
          // 2.8: a label may wrap to two lines; a value stays on one (D33).
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize);
          const lines = Math.round(r.height / lineHeight);
          const tooTall = el.classList.contains("strip-label")
            ? lines > 2
            : el.classList.contains("strip-value") && lines > 1;
          if ((!inside && !mayEllipsize) || clipped || tooTall) {
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
    await page.locator(".strip").screenshot({ path: `test-results/strip-${size.name}.png` });
    expect(report, JSON.stringify(report, null, 2)).toEqual([]);
  });
}
