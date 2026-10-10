// D38: computed styles in the real Floor, with hero-c04 through the live stream.
// The expected code face and Small sizes are 03-floor VD6 and 6.2; secondary-text
// colours are 6.3's muted tokens. The pool host is stubbed as in lead/look.spec.ts.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { POOL, serveSession, serveStream } from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

const FRAMES = readFileSync(new URL("../../fixtures/streams/hero-c04.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => ({ ...(JSON.parse(line) as Frame), pool: POOL }));

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  var part = location.pathname.split("/")[3];
  var v = "c-live";
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "advance") v = e.data.version;
  });
  function beat() {
    parent.postMessage({ type: "stats", source: part, version: v, seq: 2,
      tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

const CODE_FONTS = ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"];

for (const size of [
  { name: "stage", width: 1920, height: 1080, small: "16px" },
  { name: "laptop", width: 1440, height: 900, small: "14px" },
] as const) {
  for (const theme of [
    { name: "dark", muted: "rgb(158, 163, 172)" },
    { name: "light", muted: "rgb(87, 83, 75)" },
  ] as const) {
    test(`D38 / VD6, 6.2, 6.3: sheet labels and git code use page tokens (${size.name}, ${theme.name})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("premise.theme", value), theme.name);
      await serveStream(page, FRAMES);
      await serveSession(page, true);
      await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
      await page.goto(`/p/${POOL}`);
      await page.getByRole("tab", { name: /Landed/ }).click();
      await page.locator(".landed-row", { hasText: "crab" }).first().click();
      const why = page.locator(".why-sheet");
      await expect(why).toBeVisible();
      const headings = why.locator(".why-section > h3");
      expect(await headings.count()).toBeGreaterThan(0);
      for (const heading of await headings.all()) {
        await expect(heading).toHaveCSS("font-size", size.small);
        await expect(heading).toHaveCSS("color", theme.muted);
      }
      await expect(why.locator(".why-head")).toHaveCSS("color", theme.muted);

      await why.getByRole("button", { name: "Show the git" }).click();
      const drawer = page.locator(".git-drawer");
      await expect(drawer.locator(".git-note")).toBeVisible();
      const codeStyles = await drawer.locator(".git-row__value, .git-message, .git-note").evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            size: style.fontSize,
            fonts: style.fontFamily.split(",").map((font) => font.trim().replaceAll('"', "")),
          };
        }),
      );
      expect(codeStyles.length).toBeGreaterThanOrEqual(5);
      for (const style of codeStyles) {
        expect(style.size).toBe(size.small);
        expect(style.fonts).toEqual(CODE_FONTS);
      }
      for (const label of await drawer.locator(".git-lead, .git-row__label, .git-token").all()) {
        await expect(label).toHaveCSS("color", theme.muted);
      }
      await drawer.getByRole("button", { name: "Close", exact: true }).click();

      await why
        .locator('.why-section[data-section="relied"]')
        .getByRole("button", { name: "Who relies on this" })
        .first()
        .click();
      const who = page.locator(".who-sheet");
      await expect(who).toBeVisible();
      const whoHeadings = who.locator(".who-list > h3");
      expect(await whoHeadings.count()).toBeGreaterThan(0);
      for (const heading of await whoHeadings.all()) {
        await expect(heading).toHaveCSS("font-size", size.small);
        await expect(heading).toHaveCSS("color", theme.muted);
      }
    });
  }
}
