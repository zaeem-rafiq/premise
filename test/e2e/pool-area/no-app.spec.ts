// IR12 (docs/spec/06-repos.md): the page of a pool made from a repository — `pool.state.app`
// is null and `source` is "<owner>/<name>". The assembled Floor against an inline stream:
// no iframe once the pool's pool.state has arrived, the caption bar reading frame.no_app, the file tiles
// taking the frame's place and height, the header naming the repository, no Compare button
// and no key C — and a seed pool's page unchanged. Expected sentences and sizes come from
// the spec and the copy table, not from the page (BP1).

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ev, FLOOR_JSON, poolState, serveStream } from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

const CAPTION = "This repository has no live picture. Its files and the changes to them are below.";

// Enough files that the grid's rows pass a seed pool's cap (3 rows at stage width, 2 at
// laptop): the extra rows can only draw once the cap is lifted for the no-app area (IR12).
const PATHS = [
  "README.md",
  "package.json",
  "LICENSE",
  "src/index.ts",
  "src/app.ts",
  "src/api.ts",
  "src/db.ts",
  "src/env.ts",
  "src/log.ts",
  "src/rand.ts",
  "src/lib/util.ts",
  "src/lib/path.ts",
  "src/lib/json.ts",
  "src/lib/hash.ts",
  "docs/guide.md",
  "docs/api.md",
  "docs/deploy.md",
  "docs/design.md",
  "test/index.test.ts",
  "test/app.test.ts",
  "test/api.test.ts",
  "test/db.test.ts",
  "scripts/build.sh",
  "scripts/lint.sh",
  "scripts/test.sh",
  "css/base.css",
  "css/dark.css",
  "public/favicon.svg",
  "public/robots.txt",
];
const FILES = PATHS.map((path, i) => ({ path, tier: i === 9 ? ("held" as const) : ("auto" as const) }));

// Three files that differ only by extension — the reason the 3.7 amendment keeps the
// extension on a repository pool's tiles (IR12).
const EXT_FILES = [
  { path: "dist/index.js", tier: "auto" as const },
  { path: "dist/index.d.ts", tier: "auto" as const },
  { path: "dist/index.browser.js", tier: "auto" as const },
  { path: "package.json", tier: "auto" as const },
];

function importedStream(extra: Record<string, unknown> = {}) {
  return [poolState(1, { app: null, source: "octo/app", ...extra }), ev(2, { type: "pool.files", files: FILES })];
}

/** serveStream with a delay of its own: `frames` answer the hello `ms` late, so the pool's
 * kind stays undecided until they land (inside the first-load wait of IR12). */
async function serveLateStream(page: Page, frames: Frame[], ms: number): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      setTimeout(() => ws.send(JSON.stringify({ events: frames })), ms);
    });
  });
}

/** Every request the page makes under /pool/ — the address family a repository pool must
 * never touch. */
function watchPoolRequests(page: Page): string[] {
  const poolRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/pool/")) poolRequests.push(request.url());
  });
  return poolRequests;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  return b ?? { x: 0, y: 0, width: 0, height: 0 };
}

test.describe("IR12: a pool with no live picture", () => {
  test("holds no frame: no iframe, no /pool/ request, the frame.no_app caption", async ({ page }) => {
    const poolRequests = watchPoolRequests(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await serveStream(page, importedStream());
    await page.goto("/");

    await expect(page.locator(".pf-caption-text")).toHaveText(CAPTION);
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.locator(".pf-body")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
    await expect(page.locator(".pf-selftest")).toHaveCount(0);
    // Not one request under /pool/ — not even the one the page used to fire while it still
    // drew the seed frame's caption (the 404 in every repository pool's console).
    await page.waitForTimeout(500);
    expect(poolRequests).toEqual([]);
  });

  test("before pool.state the caption is neutral and no /pool/ request goes out (IR12)", async ({ page }) => {
    const poolRequests = watchPoolRequests(page);
    // pool.state reaches the page 2 s late — inside the first-load wait: until it lands the
    // frame waits with the neutral caption and never asks /pool/ anything it may have to
    // take back.
    await serveLateStream(page, importedStream(), 2_000);
    await page.goto("/");

    await expect(page.locator(".pf-caption-text")).toHaveText("Loading the pool…");
    await expect(page.locator(".pf-body")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(poolRequests).toEqual([]);

    // Then pool.state names the repository: the frame gives way to frame.no_app — still
    // without a single /pool/ request.
    await expect(page.locator(".pf-caption-text")).toHaveText(CAPTION);
    await expect(page.locator(".pf-body")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(poolRequests).toEqual([]);
  });

  // The seed pools' grid cap: --tile-rows × --tile-h + gaps (stage 3×56+16, laptop 2×48+8).
  for (const [w, h, cap] of [
    [1920, 1080, 184],
    [1440, 900, 104],
  ] as const) {
    test(`the file tiles take the frame's place and height at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await serveStream(page, importedStream());
      await page.goto("/");

      const caption = page.locator(".pf-caption");
      const tiles = page.locator(".tiles");
      const stage = page.locator(".pool-stage");
      // The page draws a seed pool's frame until the stream's pool.state names the pool's kind:
      // measure once the no-app caption has replaced it.
      await expect(page.locator(".pf-caption-text")).toHaveText(CAPTION);
      await expect(tiles).toBeVisible();

      const cb = await box(caption);
      const tb = await box(tiles);
      const sb = await box(stage);
      const gb = await box(page.locator(".tiles-grid"));
      // The tiles sit where the frame stood: directly under the caption bar (8 gap), and
      // their region reaches the stage's floor — the frame's former height is theirs.
      expect(Math.abs(tb.y - (cb.y + cb.height + 8))).toBeLessThanOrEqual(2);
      expect(Math.abs(tb.y + tb.height - (sb.y + sb.height))).toBeLessThanOrEqual(2);
      // Rows beyond a seed pool's cap draw — the grid fills the region, not the capped rows.
      expect(gb.height).toBeGreaterThan(cap);
      // LY3: the page does not scroll sideways.
      const overflow = await page.evaluate(
        () => Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("the tiles keep the extension, so files differing only by it stay distinct (3.7 amended)", async ({ page }) => {
    await serveStream(page, [
      poolState(1, { app: null, source: "octo/app" }),
      ev(2, { type: "pool.files", files: EXT_FILES }),
    ]);
    await page.goto("/");
    await expect(page.locator(".pf-caption-text")).toHaveText(CAPTION);

    const names = await page.locator(".tiles-grid .tile:not(.tile-label) .tile-name").allInnerTexts();
    for (const name of ["index.js", "index.d.ts", "index.browser.js", "package.json"]) {
      expect(names).toContain(name);
    }
    // no tile drops to the bare stem — that is the collision the amendment prevents
    expect(names).not.toContain("index");
  });

  test("the header names the repository; Compare and key C are absent", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    // Even with a stale plain remote on the stream, an imported pool gets no Compare.
    await serveStream(page, importedStream({ plain_remote: "https://artifacts.invalid/octo-app-plain" }));
    await page.goto("/");

    await expect(page.locator(".pool-name")).toHaveText("octo/app");
    // The start card's second button names the repository, not a live pool (start.look.repo).
    await expect(
      page.locator(".start-card").getByRole("button", { name: "Look around this repository" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare", exact: true })).toHaveCount(0);
    await expect(page.locator(".floor")).toHaveAttribute("data-view", "floor");
    await page.keyboard.press("c");
    await expect(page.locator(".floor-compare")).toHaveCount(0);
    await expect(page.locator(".floor")).toHaveAttribute("data-view", "floor");
  });

  test("a seed pool's page is unchanged", async ({ page }) => {
    const poolRequests = watchPoolRequests(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route("**/pool/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
    );
    await serveStream(page, [poolState(1), ev(2, { type: "pool.files", files: FILES.slice(0, 3) })]);
    await page.goto("/");

    await expect(page.locator(".pool-name")).toHaveText("testpool");
    await expect(page.locator(".start-card").getByRole("button", { name: "Look around the live pool" })).toBeVisible();
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    // The frame loads as soon as pool.state names the kind — not when the first-load wait
    // lapses (the hold is 3 s; this bound keeps the release honest).
    await expect(iframe).toHaveAttribute("src", /\/pool\/testpool\/main\/\?seed=\d+/, { timeout: 2_500 });
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(page.locator(".pf-caption")).toContainText("Premise · main · the seed, before any landing");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    // A tide pool's tiles still drop the extension (3.7's original rule).
    const names = await page.locator(".tiles-grid .tile:not(.tile-label) .tile-name").allInnerTexts();
    expect(names).toEqual(["README", "package", "LICENSE"]);
  });
});
