// AC10 + AC13 on the whole page, keyboard only: the focus order crosses header, strip,
// pool area, rail (and the Replay bar last), every focused element shows the page's
// focus ring, and the About sheet and a card sheet open and close without a mouse.

import { expect, test, type Page } from "@playwright/test";
import {
  serveStream,
  serveSession,
  poolState,
  intentCreated,
  attemptOpened,
  attemptState,
  cardOpened,
  choiceCard,
} from "../shell/stream.ts";

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  function beat() {
    parent.postMessage({ type: "stats", source: "main", version: "c-live", seq: 1,
      tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

const REGION = [
  ".header",
  ".strip",
  ".banners",
  ".pool-column",
  ".rail",
  ".replay-bar",
] as const;

async function focused(page: Page): Promise<{ rank: number; tag: string; cls: string; ring: boolean }> {
  return page.evaluate((regions) => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return { rank: -2, tag: "", cls: "", ring: false };
    let rank = -1;
    regions.forEach((sel, i) => {
      if (el.closest(sel) !== null) rank = i;
    });
    const cs = getComputedStyle(el);
    const ring =
      (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) ||
      cs.boxShadow !== "none";
    return { rank, tag: el.tagName, cls: String(el.className).slice(0, 60), ring };
  }, REGION as unknown as string[]);
}

test("keyboard focus order crosses every region in order (AC10)", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: POOL_PAGE }),
  );
  await page.goto("/replay/hero-c04");
  await expect(page.locator(".rail")).toBeVisible();
  await expect(page.locator(".replay-bar")).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } }); // focus at the page root

  const seen: Array<{ rank: number; tag: string; cls: string; ring: boolean }> = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (f.rank === -2) break;
    seen.push(f);
    if (seen.length > 3 && f.rank === 0) break; // wrapped around to the header
  }

  // Every focused element shows the focus ring, and every one sits in a known region.
  for (const f of seen) {
    expect(f.ring, `no focus ring on <${f.tag} class="${f.cls}">`).toBe(true);
    expect(f.rank, `focus left the page on <${f.tag} class="${f.cls}">`).toBeGreaterThanOrEqual(0);
  }
  // The order never goes backwards, and every region is reached.
  const ranks = seen.map((f) => f.rank);
  for (let i = 1; i < ranks.length; i++) {
    expect(ranks[i]!, `focus jumped back ${seen[i - 1]!.cls} -> ${seen[i]!.cls}`).toBeGreaterThanOrEqual(
      ranks[i - 1]!,
    );
  }
  for (const region of [0, 1, 3, 4, 5]) {
    expect(ranks, `region ${REGION[region]} never focused`).toContain(region);
  }
});

test("the About sheet opens and closes from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/replay/hero-c04");
  await expect(page.locator(".rail")).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("a");
  const sheet = page.locator(".about-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Premise");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("a card sheet opens and closes from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: POOL_PAGE }),
  );
  await serveStream(page, [
    poolState(1),
    intentCreated(2),
    attemptOpened(3),
    attemptState(4, "a_1", "opened", "working"),
    cardOpened(5, choiceCard("card_1", "push_rejected", "Land the change?")),
  ]);
  await serveSession(page, true);
  await page.goto("/");
  const start = page.locator(".start-card");
  if (await start.isVisible()) await page.locator(".start-card button", { hasText: /look/i }).click();
  await expect(page.locator(".tray")).toContainText("Land the change?");
  await page.locator("body").click({ position: { x: 1, y: 1 } }); // drop focus off buttons
  await page.keyboard.press("n");
  const sheet = page.locator(".card-sheet");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
