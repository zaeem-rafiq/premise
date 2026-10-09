import { expect, test } from "@playwright/test";

test("D42 2.7 3.16 LY5: named chapters and a usable track at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
  );
  await page.goto("/replay/hero-c04");
  const chapter = page.locator(".replay-chapters").getByRole("button", { name: "Conflict", exact: true });
  await expect(chapter).toBeVisible();
  await chapter.click();
  await expect(page.locator(".replay-caption")).toContainText("A change landed.");
  await expect(chapter).toHaveAttribute("aria-current", "step");
  const track = await page.locator(".replay-track").boundingBox();
  const bar = await page.locator(".replay-bar").boundingBox();
  // 2.1 as amended on 2026-10-09: the laptop Replay bar is 1440x96, two rows of 48.
  expect(bar!.height).toBe(96);
  // With the chapter buttons and the caption in their own row, the track gets at least half
  // this reference width.
  expect(track!.width).toBeGreaterThanOrEqual(720);
  expect(track!.height).toBeGreaterThanOrEqual(44);
  const targets = await page
    .locator(".replay-chapters button")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator(".replay-track").press("Home");
  await expect(page.locator(".replay-position")).toContainText("00:00:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp-test/review-replay-1440.png" });
});

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test(`D40 LY5: every Replay bar control is a 44x44 target at ${size.width}; the chapter marks are drawn ticks`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/pool/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
    );
    await page.goto("/replay/hero-c04");
    const bar = page.locator(".replay-bar");
    await expect(bar.getByRole("button", { name: "Conflict", exact: true })).toBeVisible();
    // LY5: Play, Restart, the track, Speed, Close and both chapter buttons.
    const targets = await bar.locator("button, input").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.textContent || el.getAttribute("aria-label"), width: r.width, height: r.height };
      }),
    );
    expect(targets).toHaveLength(7);
    for (const target of targets) {
      expect(target.width, `${target.name}: width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.name}: height`).toBeGreaterThanOrEqual(44);
    }
    // 3.16's chapter marks stay drawn on the track and take no pointer: the named chapter
    // buttons are the chapters' targets (D40's "the drawn size can stay").
    const marks = bar.locator(".replay-marks");
    await expect(marks).toHaveAttribute("aria-hidden", "true");
    await expect(marks).toHaveCSS("pointer-events", "none");
    expect(await marks.locator(".replay-mark").count()).toBeGreaterThan(0);
  });
}
