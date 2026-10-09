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
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
}

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

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (b === null) throw new Error(`no box for ${locator}`);
  return b;
}

const SIZES = [
  { name: "stage", w: 1920, h: 1080, poolW: 1152, frameH: 648, railW: 696, header: 64, strip: 72, banner: 40, pad: 24 },
  { name: "laptop", w: 1440, h: 900, poolW: 832, frameH: 468, railW: 560, header: 56, strip: 60, banner: 36, pad: 16 },
] as const;

/** 2.1 as amended on 2026-10-09: the Replay bar is two rows, the transport row (56, laptop 48)
 * above the chapter row (52, laptop 48). */
const REPLAY_BAR = { stage: { transport: 56, chapters: 52 }, laptop: { transport: 48, chapters: 48 } } as const;

/** The frame LY1 leaves in Replay, by 2.1's own sums: the REPLAY banner and the Replay bar take
 * height from the body (LY2); the pool area is the body less its padding, and holds the caption
 * bar (40), the frame and at least one row of tiles (64). The frame keeps 16:9 and shrinks only
 * when its full width would leave the tiles less than that row. */
function replayFrame(size: (typeof SIZES)[number]): { width: number; height: number } {
  const bar = REPLAY_BAR[size.name].transport + REPLAY_BAR[size.name].chapters;
  const area = size.h - size.header - size.strip - size.banner - bar - 2 * size.pad;
  const height = Math.min(size.frameH, area - 40 - 64);
  return { width: (height * 16) / 9, height };
}

// 2.1/LY1: the pool frame is 16:9; over a live stream it has the pool column's full width, and
// in the recording it is what LY1 leaves under the REPLAY banner and the two-row Replay bar
// (stage 1145x644, laptop 832x468). The pool column uses the body's full height.
for (const size of SIZES) {
  const frame = replayFrame(size);
  test(`the pool frame is ${Math.round(frame.width)}x${frame.height} at ${size.name} in Replay (2.1/LY1)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await servePoolHost(page);
    await page.goto("/replay/hero-c04");
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".tiles-grid .tile").first()).toBeVisible();

    const bar = await box(page.locator(".replay-bar"));
    const rows = REPLAY_BAR[size.name];
    expect(Math.abs(bar.height - (rows.transport + rows.chapters))).toBeLessThanOrEqual(1);
    const body = await box(page.locator(".pf-body"));
    expect(Math.abs(body.width - frame.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(body.height - frame.height)).toBeLessThanOrEqual(1);
    // LY1: a frame narrower than the pool area is centred in it.
    const area = await box(page.locator(".pool-area"));
    expect(Math.abs(body.x + body.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(1);

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
    await dismissStart(page);
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
        premise: {
          kind: "entity",
          key: "world/energy.js#ENERGY_MAX",
          hash: "h0",
          seq: 0,
          read: true,
          edit: false,
          derived: false,
        },
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
    await dismissStart(page);
    const energy = page.locator('.tiles-grid .tile[title="world/energy.js"]');
    const crab = page.locator('.tiles-grid .tile[title="creatures/crab.js"]');
    await expect(energy.locator(".tile-mark-r")).toHaveCount(1);
    await expect(crab.locator(".tile-mark-w")).toHaveCount(1);
  });
}

// 2.9: below 1100 the page is one column: the pool frame keeps the pool area's full width at
// 16:9 whatever the window's height, and the attempt cards follow it with a height of their own.
for (const size of [
  { w: 320, h: 568 },
  { w: 375, h: 667 },
  { w: 800, h: 600 },
  { w: 1024, h: 600 },
] as const) {
  test(`the pool frame keeps the full width at 16:9 in the narrow layout at ${size.w}x${size.h} (2.9)`, async ({
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
    await dismissStart(page);
    await expect(page.locator(".pf-body iframe")).toBeVisible();
    const area = await box(page.locator(".pool-area"));
    const body = await box(page.locator(".pf-body"));
    expect(Math.abs(body.width - area.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(body.height - (area.width * 9) / 16)).toBeLessThanOrEqual(1);
    const list = await box(page.locator(".rail-list"));
    expect(list.y).toBeGreaterThanOrEqual(body.y + body.height);
    expect(list.height).toBeGreaterThan(0);
    // The strip wraps to two rows and every counter shows whole: no value runs past its cell.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll(".strip-cell")].flatMap((cell) => {
        const value = cell.querySelector(".strip-value");
        if (value === null) return [];
        const right = value.getBoundingClientRect().right;
        return right > cell.getBoundingClientRect().right
          ? [`${cell.getAttribute("data-cell")} ${value.textContent}`]
          : [];
      }),
    );
    expect(clipped).toEqual([]);
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
