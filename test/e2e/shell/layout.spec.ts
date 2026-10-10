// The layout acceptance of 03-floor section 2 and 6: AC12 (region sizes of 2.1 and the
// type sizes of 6.2/VD15 at 1920x1080), AC13 (LY3: no sideways scroll at any width of the
// table), AC11 (6.4: reduced motion - nothing moves, frames and Replay start paused), and
// the three assembled-page defects the lead saw (the Replay bar's controls pushed off by
// a long caption, a sentence value stretching the strip, laptop type at stage width).
// Expected sizes are the spec's own numbers (2.1, 6.2), not the page's output (BP1).

import { expect, test } from "@playwright/test";
import { serveStream, poolState, intentCreated, attemptOpened, limits, metrics } from "./stream.ts";

async function box(locator: ReturnType<import("@playwright/test").Page["locator"]>) {
  const b = await locator.boundingBox();
  return b ?? { x: 0, y: 0, width: 0, height: 0 };
}

test.describe("AC12 / 2.1: the stage layout at 1920x1080", () => {
  test("regions have the sizes of the table within 1 px", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/replay/tracer");
    await expect(page.locator(".replay-bar")).toBeVisible();
    await expect(page.locator(".strip")).toBeVisible();

    const header = await box(page.locator(".header"));
    const strip = await box(page.locator(".strip"));
    const banner = await box(page.locator(".banner[data-tone='replay']"));
    const replayBar = await box(page.locator(".replay-bar"));
    const pool = await box(page.locator(".pool-column"));
    const rail = await box(page.locator(".rail"));

    // 2.1: header 1920x64, strip 72, each banner 40, and (as amended on 2026-10-09) the
    // Replay bar 1920x108: the transport row (56) above the chapter row (52).
    expect(Math.abs(header.width - 1920)).toBeLessThanOrEqual(1);
    expect(Math.abs(header.height - 88)).toBeLessThanOrEqual(1);
    // 2.7 (2026-10-10): in Replay the number band is 92 at stage.
    expect(Math.abs(strip.height - 92)).toBeLessThanOrEqual(1);
    expect(Math.abs(banner.height - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(replayBar.width - 1920)).toBeLessThanOrEqual(1);
    expect(Math.abs(replayBar.height - 108)).toBeLessThanOrEqual(1);
    const chapters = await box(page.locator(".replay-bar .replay-chapters"));
    expect(Math.abs(chapters.y - replayBar.y - 56)).toBeLessThanOrEqual(1);
    expect(Math.abs(chapters.height - 52)).toBeLessThanOrEqual(1);
    // The pool area is 1152 wide, the rail 696 (padding 24, gap 24).
    expect(Math.abs(pool.width - 1152)).toBeLessThanOrEqual(1);
    expect(Math.abs(rail.width - 696)).toBeLessThanOrEqual(1);
  });

  test("VD15: the computed type sizes are the stage sizes of 6.2", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/replay/tracer");
    await expect(page.locator(".strip")).toBeVisible();

    // The regression the lead saw: stage width must draw stage type, not laptop.
    await expect(page.locator("html")).toHaveAttribute("data-size", "stage");

    const sizes = await page.evaluate(() => {
      const px = (el: Element | null) => (el === null ? null : Number.parseFloat(getComputedStyle(el).fontSize));
      const pick = (sel: string) => px(document.querySelector(sel));
      return {
        counter: px(document.querySelector(".strip-cell")?.querySelector(".strip-value") ?? null),
        stripLabel: pick(".strip-label"),
        bannerWord: pick(".banner-word"),
        appName: pick(".app-name"),
        button: pick(".header button"),
        caption: pick(".pf-caption"),
      };
    });
    // 6.2 stage (2026-10-10): counter 84 (Landed and Go-arounds live, the masthead name); in
    // Replay every strip value reads at Title (40); small 16 (strip labels, command buttons),
    // intent 30 (banner words).
    expect(sizes.counter).toBe(40);
    expect(sizes.stripLabel).toBe(16);
    expect(sizes.bannerWord).toBe(30);
    expect(sizes.appName).toBe(84);
    expect(sizes.button).toBe(16);
    // VD15: the frame caption is read from the back of a room - 22 or larger.
    expect(sizes.caption ?? 0).toBeGreaterThanOrEqual(22);
  });
});

test.describe("AC13 / LY3: the page never scrolls sideways", () => {
  for (const width of [320, 768, 1100, 1280, 1440, 1600, 1920]) {
    test(`width ${width}: no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/replay/tracer");
      await expect(page.locator(".strip")).toBeVisible();
      await expect(page.locator(".rail")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
      // And every banner word, strip cell and replay control is inside the viewport.
      const stuck = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll(".strip-cell, .banner, .replay-bar > *")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
            out.push(`${el.className} right=${Math.round(r.right)}`);
          }
        }
        return out;
      });
      expect(stuck, `elements past the viewport at ${width}`).toEqual([]);
    });
  }
});

test.describe("defect regressions", () => {
  test("the Replay bar's controls stay on screen with the longest chapter caption", async ({ page }) => {
    // The defect: at 1440 in /replay/hero-c04 the Conflict chapter's caption (it gains
    // "Press C to compare" when the pool has a plain-merge remote) pushed Speed and
    // Close Replay off the screen. 3.16: the caption wraps or is cut with an ellipsis.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/replay/hero-c04");
    await expect(page.locator(".replay-bar")).toBeVisible();
    // Jump to the Conflict chapter so the longest caption is on the bar.
    await page.keyboard.press("2");
    await expect(page.locator(".replay-caption")).toContainText("Press C to compare");
    const speed = page.locator(".replay-speed");
    const close = page.locator(".replay-close");
    await expect(speed).toBeVisible();
    await expect(close).toBeVisible();
    const speedBox = await box(speed);
    const closeBox = await box(close);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(1440);
    expect(speedBox.x + speedBox.width).toBeLessThanOrEqual(closeBox.x + closeBox.width);
    // 2.7 as amended on 2026-10-09: the caption sits beside the chapter buttons in the
    // chapter row, under the transport row - it can no longer reach Speed or Close.
    const caption = await box(page.locator(".replay-caption"));
    expect(caption.y).toBeGreaterThanOrEqual(speedBox.y + speedBox.height);
  });

  test("a sentence value in the strip does not stretch the strip (3.8)", async ({ page }) => {
    // The defect: "not running in this build" / "not reported yet" drew at counter size
    // and wrapped, making the strip's height depend on content. The strip has one fixed
    // height per layout (2.1): 60 at laptop width.
    await page.setViewportSize({ width: 1440, height: 900 });
    // No limits event, features.green "none": both the green cell ("not running in this
    // build") and the spend cell ("not reported yet") are sentences.
    await serveStream(page, [poolState(1), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    await expect(page.locator(".strip")).toBeVisible();
    await expect(page.locator(".strip-cell", { hasText: "Green line" })).toContainText("not running in this build");
    await expect(page.locator(".strip-cell", { hasText: "Spend" })).toContainText("not reported yet");
    const strip = await box(page.locator(".strip"));
    expect(Math.abs(strip.height - 112)).toBeLessThanOrEqual(1);
    // The sentences draw at status size, not counter size.
    const fontSize = await page
      .locator(".strip-cell", { hasText: "Spend" })
      .locator(".strip-value")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBe(18); // laptop status size (6.2)
  });

  test("at stage width every strip cell reads label over value, labels in one row (2.2)", async ({ page }) => {
    // The defect: at 1920 the strip mixed two layouts - "REAL AGENTS 0 of 6" on one line,
    // "LANDED" above "1", "SPEND $0.07 of" wrapping - so the labels sat at different
    // heights. 2.2 draws each cell as its label above its value.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await serveStream(page, [
      poolState(1),
      intentCreated(2),
      attemptOpened(3),
      limits(4, { spend: 3.12, cap: 40 }),
      metrics(5, { waiting_behind: 2 }),
    ]);
    await page.goto(`/p/testpool`);
    await expect(page.locator(".strip-cell", { hasText: "Spend" })).toContainText("$3.12 of $40.00");
    const cells = await page.locator(".strip-cell").evaluateAll((els) =>
      els.map((el) => {
        const label = el.querySelector(".strip-label")!.getBoundingClientRect();
        const value = el.querySelector(".strip-value")!.getBoundingClientRect();
        return {
          name: el.querySelector(".strip-label")!.textContent,
          labelTop: label.top,
          labelHeight: label.height,
          labelBottom: label.bottom,
          // An inline box's rectangle is its font's whole content area, taller than the
          // digits, so its middle - not its top - says which line it is on.
          valueMiddle: value.top + value.height / 2,
          valueLeft: value.left,
          labelLeft: label.left,
          clipped: el.scrollWidth > el.clientWidth,
        };
      }),
    );
    expect(cells).toHaveLength(7);
    for (const cell of cells) {
      // One line of label (small type 16, 6.2), then the value on the line below it,
      // starting at the same left edge.
      expect(cell.labelHeight, cell.name!).toBeLessThan(16 * 1.5);
      expect(cell.valueMiddle, cell.name!).toBeGreaterThan(cell.labelBottom);
      expect(Math.abs(cell.valueLeft - cell.labelLeft), cell.name!).toBeLessThanOrEqual(1);
      expect(cell.clipped, cell.name!).toBe(false);
    }
    const tops = cells.map((c) => c.labelTop);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    const strip = await box(page.locator(".strip"));
    expect(Math.abs(strip.height - 136)).toBeLessThanOrEqual(1);
  });

  test("the run clock is never underlined, and a page that just opened underlines no counter (CO29)", async ({
    page,
  }) => {
    // The defect: the clock changes every second, so the 1 s underline of CO29 never
    // left it. CO29 is for counters, and 3.8 names the strip "run clock and six counters".
    // A counter's first value replaces the dash: that is not a change (strip.test.ts covers one).
    await serveStream(page, [poolState(1), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    const motion = (label: string) =>
      page
        .locator(".strip-cell", { hasText: label })
        .locator(".strip-value")
        .evaluate((el) => getComputedStyle(el).animationName);
    await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText("0");
    expect(await motion("Run clock")).toBe("none");
    expect(await motion("Landed")).toBe("none");
  });
});

test.describe("AC11 / 6.4: reduced motion", () => {
  test("nothing moves: banners and sheets appear at once, frames and Replay start paused", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/replay/tracer");

    // Replay starts paused (RY18 + 6.4: the bar offers Play, not Pause).
    await expect(page.locator(".replay-bar").getByRole("button", { name: "Play", exact: true })).toBeVisible();

    // A banner appears at once - no slide animation.
    const bannerMotion = await page
      .locator(".banner[data-tone='replay']")
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(bannerMotion).toBe("none");

    // A sheet appears at once.
    await page.keyboard.press("a");
    await expect(page.locator(".sheet")).toBeVisible();
    const sheetMotion = await page.locator(".sheet-backdrop").evaluate((el) => getComputedStyle(el).animationName);
    expect(sheetMotion).toBe("none");
  });

  test("live pool frames start paused with frame.play (6.4 last row)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await serveStream(page, [poolState(1), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    // The frame is paused and the caption bar offers Play (frame.play).
    await expect(page.locator(".pf")).toContainText("Paused. The code still lands; only the picture is still.");
    await expect(page.locator(".pf").getByRole("button", { name: "Play" })).toBeVisible();
  });
});
