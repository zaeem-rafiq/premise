// Whole-page acceptance of the Floor's regions at the two reference sizes (03-floor 2.1,
// LY1-LY3): the pool frame is 16:9 at the pool column's full width, the pool column uses
// the height the body gives it, the file tiles show the pool's files, and the Floor view
// never scrolls the page in any direction. Every expected number is the spec's (BP1).

import { expect, test, type Page, type Locator } from "@playwright/test";
import {
  serveStream,
  serveSession,
  ev,
  poolState,
  intentCreated,
  attemptOpened,
  attemptState,
} from "../shell/stream.ts";

/** The fake pool host of the pool-area specs: answers the frame's probe with a stats
 * message so a live frame reaches its `live` state. */
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

async function servePoolHost(page: Page): Promise<void> {
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: POOL_PAGE }),
  );
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (b === null) throw new Error(`no box for ${locator}`);
  return b;
}

const SIZES = [
  { name: "stage", w: 1920, h: 1080, poolW: 1152, frameH: 648, railW: 696 },
  { name: "laptop", w: 1440, h: 900, poolW: 832, frameH: 468, railW: 560 },
] as const;

// 2.1/LY1: at both sizes the pool frame is 16:9 at the pool column's full width, in the
// recording and over a live stream. The pool column uses the body's full height.
for (const size of SIZES) {
  test(`the pool frame is ${size.poolW}x${size.frameH} at ${size.name} in Replay (2.1/LY1)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await servePoolHost(page);
    await page.goto("/replay/hero-c04");
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".tiles-grid .tile").first()).toBeVisible();

    const body = await box(page.locator(".pf-body"));
    expect(Math.abs(body.width - size.poolW)).toBeLessThanOrEqual(1);
    expect(Math.abs(body.height - size.frameH)).toBeLessThanOrEqual(1);

    // The rail takes its 2.1 width and the strip its height.
    const rail = await box(page.locator(".rail"));
    expect(Math.abs(rail.width - size.railW)).toBeLessThanOrEqual(1);
    const strip = await box(page.locator(".strip"));
    expect(Math.abs(strip.height - (size.name === "stage" ? 72 : 60))).toBeLessThanOrEqual(1);

    // The pool column uses the height it has: the stage fills the column's own box, the
    // tiles region keeps at least its one guaranteed row under it (LY1).
    const column = await box(page.locator(".pool-column"));
    const stage = await box(page.locator(".pool-stage"));
    expect(stage.height / column.height).toBeGreaterThan(0.9);
    const tiles = await box(page.locator(".tiles"));
    expect(tiles.height).toBeGreaterThanOrEqual(64);
    expect(Math.abs(tiles.width - size.poolW)).toBeLessThanOrEqual(1);
  });

  test(`the pool frame is ${size.poolW}x${size.frameH} at ${size.name} over a live stream (2.1/LY1)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await servePoolHost(page);
    await serveStream(page, [
      poolState(1),
      ev(2, {
        type: "pool.files",
        files: [
          { path: "world/energy.js", tier: "auto" },
          { path: "creatures/crab.js", tier: "auto" },
        ],
      }),
      intentCreated(3),
      attemptOpened(4),
      attemptState(5, "a_1", "opened", "working"),
    ]);
    await serveSession(page, false);
    await page.goto("/");
    await expect(page.locator(".rail")).toBeVisible();
    // Dismiss the start card so it does not sit over the pool area.
    const startCard = page.locator(".start-card");
    if (await startCard.isVisible()) {
      await page.locator(".start-card button", { hasText: /look/i }).click();
    }
    await expect(page.locator(".pf-body iframe")).toBeVisible();
    const body = await box(page.locator(".pf-body"));
    expect(Math.abs(body.width - size.poolW)).toBeLessThanOrEqual(1);
    expect(Math.abs(body.height - size.frameH)).toBeLessThanOrEqual(1);
  });

  // 3.7: one tile per file of the stream's pool.files, up to the size's capacity.
  test(`the file tiles show the pool's files at ${size.name} in Replay (3.7)`, async ({ page }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await servePoolHost(page);
    await page.goto("/replay/hero-c04");
    await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 30_000 });
    // The recording's pool.files names 5 files; a write early in the stream adds
    // creatures/crab.js. The grid holds one label cell per directory plus one tile per
    // file, and a tile's name drops the extension (3.7): 3 labels + 6 files = 9 cells.
    const names = await page.locator(".tiles-grid .tile .tile-name").allInnerTexts();
    for (const file of ["policy", "energy", "movement", "fish", "snail", "crab"]) {
      expect(names).toContain(file);
    }
    for (const dir of [".premise/", "world/", "creatures/"]) {
      expect(names).toContain(dir);
    }
    expect(names).toHaveLength(9);
  });
}

// 3.7: the reader and writer marks of an in-flight attempt, over a live stream.
for (const size of SIZES) {
  test(`the tiles carry an in-flight attempt's marks at ${size.name} (3.7)`, async ({ page }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await servePoolHost(page);
    await serveStream(page, [
      poolState(1),
      ev(2, {
        type: "pool.files",
        files: [
          { path: "world/energy.js", tier: "auto" },
          { path: "creatures/crab.js", tier: "auto" },
        ],
      }),
      intentCreated(3),
      attemptOpened(4),
      attemptState(5, "a_1", "opened", "working"),
      ev(6, {
        type: "premise.recorded",
        attempt_id: "a_1",
        tool: "read",
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX", hash: "h0", seq: 0, read: true, edit: false, derived: false },
      }),
      ev(7, {
        type: "op.recorded",
        attempt_id: "a_1",
        op_seq: 1,
        op: "write",
        path: "creatures/crab.js",
        targets: ["creatures/crab.js#update"],
        altered: [],
        added: ["creatures/crab.js#update"],
        removed: [],
      }),
    ]);
    await serveSession(page, false);
    await page.goto("/");
    const startCard = page.locator(".start-card");
    if (await startCard.isVisible()) {
      await page.locator(".start-card button", { hasText: /look/i }).click();
    }
    const energy = page.locator(".tiles-grid .tile:not(.tile-label)", { hasText: "energy" });
    const crab = page.locator(".tiles-grid .tile:not(.tile-label)", { hasText: "crab" });
    await expect(energy.locator(".tile-mark-r")).toHaveCount(1);
    await expect(crab.locator(".tile-mark-w")).toHaveCount(1);
  });
}

// LY3/AC13 on the Floor view: no sideways and no vertical page scroll at every width
// 1100-1920 and every height 720-1080. Run on Replay - the busier DOM (banner + bar).
for (const w of [1100, 1280, 1440, 1600, 1920]) {
  for (const h of [720, 900, 1080]) {
    test(`no page scroll at ${w}x${h} (LY3/AC13)`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/replay/hero-c04");
      await expect(page.locator(".rail")).toBeVisible();
      const sizes = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        sh: document.documentElement.scrollHeight,
        iw: window.innerWidth,
        ih: window.innerHeight,
      }));
      expect(sizes.sw).toBeLessThanOrEqual(sizes.iw);
      expect(sizes.sh).toBeLessThanOrEqual(sizes.ih);
    });
  }
}
