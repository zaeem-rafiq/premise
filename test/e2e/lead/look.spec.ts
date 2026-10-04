// The lead's visual pass (item 8): for `hero-c04`, at the moment the crab is "Going
// around" and at the recording's end, one full-page screenshot per size and theme under
// test-results/lead-look/. The screenshots are for eyes, not assertions.

import { expect, test } from "@playwright/test";

const SIZES = [
  { name: "stage", w: 1920, h: 1080 },
  { name: "laptop", w: 1440, h: 900 },
] as const;
const THEMES = ["dark", "light"] as const;

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  var part = location.pathname.split("/")[3];
  var v = (part === "main" || part === "green" || part === "plain") ? "c-live" : "c-" + part;
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "advance") v = e.data.version;
  });
  function beat() {
    parent.postMessage({ type: "stats", source: part, version: v, seq: 1,
      tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

for (const size of SIZES) {
  for (const theme of THEMES) {
    test(`lead-look ${size.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.addInitScript(
        ([key, value]) => window.localStorage.setItem(key as string, value as string),
        ["premise.theme", theme] as const,
      );
      await page.route("**/pool/**", (route) =>
        route.fulfill({ contentType: "text/html", body: POOL_PAGE }),
      );
      await page.goto("/replay/hero-c04");
      await expect(page.locator(".rail")).toBeVisible();

      // The crab's attempt card reads "Going around" between its heads-up (n=30) and its
      // resubmission (n=39): play at 1x and catch the status, then pause for the shot.
      const card = page.locator(".rail-list .attempt-card", { hasText: "crab" });
      await expect(card.locator(".attempt-card__word")).toContainText("Going around", {
        timeout: 30_000,
      });
      await page.keyboard.press(" ");
      await page.screenshot({
        path: `test-results/lead-look/${size.name}-${theme}-going-around.png`,
        fullPage: true,
      });

      // To the end: 8x, wait for the ended row.
      await page.keyboard.press(" ");
      await page.keyboard.press(".");
      await page.keyboard.press(".");
      await page.keyboard.press(".");
      await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({
        path: `test-results/lead-look/${size.name}-${theme}-end.png`,
        fullPage: true,
      });
    });
  }
}
