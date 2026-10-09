// Design review D3: exercise the built Floor, so the test includes the stylesheet
// ordering that hid the lane harness's correct sheet geometry. Numbers come from
// 03-floor 2.5, 2.8 and the design-fix brief (the undo sheet's 560 px width).

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { FLOOR_JSON, POOL, serveSession, serveStream } from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

const FRAMES = readFileSync(new URL("../../fixtures/streams/hero-c04.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => ({ ...(JSON.parse(line) as Frame), pool: POOL }));

// The fixture server has no pool host. Keep the real frame channel alive, as in
// lead/look.spec.ts, while the real Floor receives hero-c04 through its stream.
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

const SIZES = [
  { name: "stage", width: 1920, height: 1080, sheet: 760 },
  { name: "laptop", width: 1440, height: 900, sheet: 560 },
] as const;

async function openWhy(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((value) => localStorage.setItem("premise.theme", value), theme);
  await serveStream(page, FRAMES, [], FLOOR_JSON);
  await serveSession(page, true);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await page.route("**/api/pools/*/undo-plan**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        plan: { target_seq: 2, reverted: [2], reopened: ["a_A"], kept_readers: [], repairs: [] },
      }),
    }),
  );
  await page.goto(`/p/${POOL}`);
  await expect(page.getByRole("button", { name: "Owner", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Landed/ }).click();
  await page.locator(".landed-row", { hasText: "crab" }).first().click();
  await expect(page.locator(".why-sheet")).toBeVisible();
}

async function expectRightEdge(sheet: Locator, width: number, viewport: number): Promise<void> {
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeCloseTo(width, 0);
  expect(box!.x + box!.width).toBeCloseTo(viewport, 0);
}

async function expectClearPool(page: Page, backdrop: Locator): Promise<void> {
  await expect(page.locator(".pool-column iframe").first()).toBeVisible();
  // A translucent covering still leaves the iframe "visible" to Playwright, so
  // check the backdrop's actual paint as well as the right-edge sheet geometry.
  await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(backdrop).toHaveCSS("background-image", "none");
}

for (const size of SIZES) {
  for (const theme of ["dark", "light"] as const) {
    test(`D3 / 2.5, 2.8, CO23b: Why and Who dock right with the pool clear (${size.name}, ${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openWhy(page, theme);
      await expectRightEdge(page.locator(".why-sheet"), size.sheet, size.width);
      await expectClearPool(page, page.locator(".why-backdrop"));

      await page
        .locator('.why-section[data-section="relied"]')
        .getByRole("button", { name: "Who relies on this" })
        .first()
        .click();
      const who = page.locator(".who-sheet");
      await expect(who).toBeVisible();
      await expectRightEdge(who, size.sheet, size.width);
      await expectClearPool(page, page.locator(".who-backdrop"));
      await page.keyboard.press("Escape");
      await expect(who).toHaveCount(0);
    });

    test(`D3 / 2.5, 2.8: git drawer sits against Why and covers the laptop pool (${size.name}, ${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openWhy(page, theme);
      await page.locator(".why-sheet").getByRole("button", { name: "Show the git" }).click();
      const drawer = page.locator(".git-drawer");
      await expect(drawer).toBeVisible();
      await expectRightEdge(page.locator(".why-sheet"), size.sheet, size.width);
      const why = (await page.locator(".why-sheet").boundingBox())!;
      const git = (await drawer.boundingBox())!;
      expect(git.x + git.width).toBeCloseTo(why.x, 0);
      if (size.name === "stage") {
        expect(git.width).toBeCloseTo(720, 0);
        expect(git.x).toBeCloseTo(440, 0);
      } else {
        expect(git.x).toBeCloseTo(0, 0);
        const pool = (await page.locator(".pool-column").boundingBox())!;
        expect(git.x + git.width).toBeGreaterThanOrEqual(pool.x + pool.width);
      }
      await drawer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(drawer).toHaveCount(0);
      await expect(page.locator(".why-sheet")).toBeVisible();
    });

    test(`D3 / brief, 3.12: undo plan uses the 560 px sheet (${size.name}, ${theme})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWhy(page, theme);
      await page.locator(".why-sheet").getByRole("button", { name: "Undo", exact: true }).click();
      const undo = page.locator(".undo-sheet");
      await expect(undo.getByRole("button", { name: "Undo it", exact: true })).toBeEnabled();
      const box = await undo.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeCloseTo(560, 0);
      await undo.getByRole("button", { name: "Keep it", exact: true }).click();
      await expect(undo).toHaveCount(0);
    });
  }
}
