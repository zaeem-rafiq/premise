// The wiring the lanes left for this pass, on the real page:
//  - the card sheet renders exactly once, through the registry's `sheet.card` entry and
//    the shell's `SheetTarget` (the rail no longer draws it);
//  - a file tile's menu opens the Who panel and the Why card through the shell;
//  - the self-test badge shows on the main frame;
//  - `intent.queue` fills its `{max}` from `pool.max_real_agents` (FR26).

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  serveStream,
  serveSession,
  ev,
  poolState,
  intentCreated,
  attemptOpened,
  attemptState,
  cardOpened,
  choiceCard,
  metrics,
  limits,
} from "../shell/stream.ts";

/** The events of a recorded fixture, served as one live stream of the shell's test pool. */
function fixtureFrames(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(`../../fixtures/streams/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => typeof event.type === "string")
    .map((event, i) => ev(i + 1, event));
}

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  var part = location.pathname.split("/")[3];
  var v = (part === "main" || part === "green" || part === "plain") ? "c-live" : "c-" + part;
  window.__st = null;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.type === "advance") v = d.version;
    if (d && d.type === "probe" && d.selftest === true) {
      window.__st = { version: v, ok: true, failed: [] };
    }
  });
  function beat() {
    parent.postMessage({ type: "stats", source: part, version: v, seq: 1,
      tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: window.__st }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

for (const size of [
  { name: "stage", w: 1920, h: 1080 },
  { name: "laptop", w: 1440, h: 900 },
]) {
  test.describe(`at ${size.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
    });

    /** Dismisses the start card if it is on screen. The card mounts and unmounts as the
     * stream's quiet test flips, so a Playwright click can lose its element mid-action — the
     * click goes through evaluate on the DOM as it stands. */
    async function dismissStart(page: Page): Promise<void> {
      await page
        .locator(".start-card")
        .first()
        .waitFor({ state: "attached", timeout: 3000 })
        .catch(() => {});
      await page.evaluate(() => {
        for (const b of document.querySelectorAll<HTMLButtonElement>(".start-card button")) {
          if (/look/i.test(b.textContent ?? "")) b.click();
        }
      });
    }

    // (b) One place draws the card sheet: the shell's SheetTarget -> the registry's
    // sheet.card binding. A tap on the tray's Open button or key N opens it; Esc closes.
    test("the card sheet draws once, through sheet.card", async ({ page }) => {
      await serveStream(page, [
        poolState(1),
        intentCreated(2),
        attemptOpened(3),
        attemptState(4, "a_1", "opened", "working"),
        cardOpened(5, choiceCard("card_1", "push_rejected", "Land the change?")),
      ]);
      await serveSession(page, false);
      await page.goto("/");
      await dismissStart(page);
      await expect(page.locator(".tray")).toContainText("Land the change?");
      await page.locator(".tray-row button", { hasText: "Open" }).click();
      const sheet = page.locator(".card-sheet");
      await expect(sheet).toHaveCount(1);
      await expect(sheet).toContainText("Land the change?");
      await sheet
        .getByRole("button", { name: /close|Close/ })
        .first()
        .click();
      await expect(sheet).toHaveCount(0);
    });

    // (a) The tile menu (3.7): with the Who and Why sheets registered (Slice 7), a file tile
    // opens a menu, and each entry opens its sheet in the assembled page - the Who panel names
    // the tapped file, and the Why card opens on the file's newest landing (hero-c04: the crab
    // landed as landing 2).
    test("a file tile's menu opens Who relies and the Why card", async ({ page }) => {
      await serveStream(page, fixtureFrames("hero-c04.ndjson"));
      await page.goto("/p/testpool");
      await dismissStart(page);
      const crab = page.locator('.tiles-grid button.tile[title="creatures/crab.js"]');
      await crab.click();
      await page.getByRole("menuitem", { name: "Who relies on this" }).click();
      const who = page.getByRole("dialog", { name: /^Who relies on .*crab/ });
      await expect(who).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(who).toHaveCount(0);

      await crab.click();
      await page.getByRole("menuitem", { name: "Why (newest change)" }).click();
      const why = page.getByRole("dialog", { name: "Why is this here?" });
      await expect(why).toBeVisible();
      await expect(why).toContainText("landing 2");
    });

    // (a) The self-test badge on the main frame (CO25a).
    test("the self-test badge shows on the pool frame", async ({ page }) => {
      await page.goto("/replay/hero-c04");
      await expect(page.locator(".pf-selftest")).toBeVisible();
      await expect(page.locator(".pf-selftest")).toContainText(/Self-test/);
    });

    // (c) intent.queue's {max}: with every slot busy the note reads the pool's limit.
    test("intent.queue names the pool's agent limit (FR26)", async ({ page }) => {
      await serveStream(page, [
        poolState(1, { real_agents: 6, max_real_agents: 6 }),
        intentCreated(2),
        attemptOpened(3),
        attemptState(4, "a_1", "opened", "working"),
        metrics(5),
        limits(6, { spend: 1.0, cap: 40.0 }),
      ]);
      await serveSession(page, true);
      await page.goto("/");
      await dismissStart(page);
      await expect(page.locator(".intent-note")).toContainText("All 6 agent slots are busy");
    });
  });
}
