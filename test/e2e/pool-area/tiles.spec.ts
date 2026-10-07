// The file tiles of docs/spec/03-floor.md 3.7 (CO26-CO28), mounted inside the lane's PoolArea in
// the same style of harness as frame.spec.ts — a real Chromium page with a fake pool host — so
// the grid, the marks, the removed tile, the +more list and the tile menu are exercised end to
// end. Expected values come from the tracer fixture and fabricated events through the reducer,
// never from what the page happens to draw (BP1).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
// fullyParallel runs beforeAll in every worker, and a build rewrites files in place: each worker
// builds into a directory of its own, so no test reads a file that another worker is rewriting.
const HARNESS_DIR = join(ROOT, `.tmp-test/e2e-tiles-${process.env.TEST_PARALLEL_INDEX ?? "0"}`);
const HARNESS_DIST = join(HARNESS_DIR, "dist");

const TRACER = readFileSync(join(ROOT, "test/fixtures/streams/tracer.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const EVENTS = TRACER.filter((line) => typeof line.type === "string");
// index 14 is op.recorded (a_T writes creatures/fish.js); the listing premise at index 11 is
// still held then — index 15 removes it.
const MARKS_IX = 14;
const LANDED_IX_1 = EVENTS.findIndex((e) => e.type === "landing.landed");

const HARNESS_MAIN = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PoolArea } from "../../src/floor/components/pool-frame/pool-area.tsx";
import { emptyFloorState, reduce } from "../../src/protocol/reducer/index.ts";

declare const window: Window & { harness?: Record<string, unknown>; tileWho?: string; tileWhy?: { path: string; seq: number } };

function Harness() {
  const [state, setState] = useState(() => emptyFloorState());
  window.harness = {
    event: (e: unknown) => setState((s) => ({ ...reduce(s, e as never) })),
    tileWho: () => window.tileWho,
    tileWhy: () => window.tileWhy,
  };
  return (
    <PoolArea
      pool="tidepool"
      state={state}
      mode="live"
      onTileWho={(p) => { window.tileWho = p; }}
      onTileWhy={(p, seq) => { window.tileWhy = { path: p, seq }; }}
    />
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
`;

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>tiles harness</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`;

const HARNESS_VITE = `
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: false },
});
`;

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__tick = 0;
  parent.postMessage({ type: "stats", source: "main", version: "c-live", seq: 1,
    tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
</script>`;

async function serveHarness(page: Page): Promise<void> {
  await page.route("**/assets/**", async (route) => {
    const file = join(HARNESS_DIST, "assets", basename(new URL(route.request().url()).pathname));
    await route.fulfill({ path: file });
  });
  await page.route("**/pool/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: POOL_PAGE });
  });
  await page.route("**/harness", async (route) => {
    await route.fulfill({ path: join(HARNESS_DIST, "index.html"), contentType: "text/html" });
  });
  await page.goto("/harness");
  await expect(page.locator(".pool-area")).toBeVisible();
}

async function sendEvents(page: Page, throughIndex: number, extra: unknown[] = []): Promise<void> {
  await page.evaluate(
    ([events, through, more]) => {
      const harness = (window as { harness?: { event: (e: unknown) => void } }).harness;
      for (const e of (events as unknown[]).slice(0, (through as number) + 1)) harness?.event(e);
      for (const e of more as unknown[]) harness?.event(e);
    },
    [EVENTS, throughIndex, extra] as const,
  );
}

/** A fabricated removal landing: seq 3 takes creatures/snail.js off main (write.new "absent"). */
const REMOVE_SNAIL = [
  {
    ts: 1704067209600,
    src: "trunk",
    type: "landing.accepted",
    seq: 3,
    batch_id: 3,
    kind: "change",
    attempt_id: null,
    change_id: "c-rm",
    intent_id: null,
    request_id: null,
    paths: ["creatures/snail.js"],
    writes: [{ kind: "file", key: "creatures/snail.js", old: "h-snail", new: "absent" }],
    n: 46,
    t: 1704067209605,
    pool: "tidepool",
  },
  {
    ts: 1704067209800,
    src: "trunk",
    type: "landing.landed",
    seq: 3,
    batch_id: 3,
    commit: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0e2",
    tree: "tree-3",
    note: "note-3",
    note_json: "{}",
    time_to_land_ms: 100,
    n: 47,
    t: 1704067209805,
    pool: "tidepool",
  },
];

const TILES = ".tiles .tiles-scroll";

test.beforeAll(() => {
  mkdirSync(HARNESS_DIR, { recursive: true });
  writeFileSync(join(HARNESS_DIR, "index.html"), HARNESS_HTML);
  writeFileSync(join(HARNESS_DIR, "main.tsx"), HARNESS_MAIN);
  writeFileSync(join(HARNESS_DIR, "vite.config.ts"), HARNESS_VITE);
  execFileSync("npx", ["vite", "build", "--config", join(HARNESS_DIR, "vite.config.ts")], {
    cwd: ROOT,
    stdio: "pipe",
  });
});

test.describe("the file tiles (3.7)", () => {
  test("3.7 loading: before pool.files the region shows grey cells and tiles.loading", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0); // pool.state only
    await expect(page.locator(`${TILES} .tile-ghost`).first()).toBeVisible();
    await expect(page.locator(".tiles-loading")).toHaveText("Loading the file list…");
  });

  test("3.7/CO26: directory labels, file names, held tag and marks come from FloorState", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, MARKS_IX);
    const cells = page.locator(`${TILES} .tile`);
    // pool.files order of the tracer: .premise/policy.json (held), world/{energy,movement},
    // creatures/{fish,snail} — each group led by its label cell.
    await expect(page.locator(`${TILES} .tile-label`).nth(0)).toContainText(".premise/");
    await expect(page.locator(`${TILES} .tile-label`).nth(1)).toContainText("world/");
    await expect(page.locator(`${TILES} .tile-label`).nth(2)).toContainText("creatures/");
    for (const name of ["policy", "energy", "movement", "fish", "snail"]) {
      await expect(cells.filter({ hasText: name }).first()).toBeVisible();
    }
    // The held path carries tile.held; the listing premise marks the creatures/ label;
    // fish.js carries a_T's reader ring and writer square.
    await expect(cells.filter({ hasText: "policy" })).toContainText("Held");
    await expect(page.locator(`${TILES} .tile-label`, { hasText: "creatures/" }).locator(".tile-mark-r")).toHaveCount(
      1,
    );
    const fish = cells.filter({ hasText: "fish" });
    await expect(fish.locator(".tile-mark-r")).toHaveCount(1);
    await expect(fish.locator(".tile-mark-w")).toHaveCount(1);
    // AX7: the accessible name is tile.name — path, readers, writers.
    await expect(fish).toHaveAttribute("aria-label", "creatures/fish.js. 1 reading, 1 writing.");
  });

  test("3.7 landed + stopped: a landed file glows; a removed file shows tile.removed then leaves", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, LANDED_IX_1);
    const fish = page.locator(`${TILES} .tile`, { hasText: "fish" });
    await expect(fish).toHaveClass(/tile-glow/);
    await sendEvents(page, LANDED_IX_1, REMOVE_SNAIL);
    const snail = page.locator(`${TILES} .tile-removed`);
    await expect(snail).toContainText("snail");
    await expect(snail).toContainText("Removed");
    await expect(snail).toBeHidden({ timeout: 4_000 }); // leaves after 2 s
  });

  test("CO28: more files than cells ends in tiles.more, which opens the full list", async ({ page }) => {
    await page.setViewportSize({ width: 1152, height: 800 });
    await serveHarness(page);
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `creatures/c${String(i).padStart(2, "0")}.js`,
      tier: "auto",
    }));
    files.push({ path: ".premise/policy.json", tier: "held" });
    await sendEvents(page, 0, [{ ts: 1, src: "trunk", type: "pool.files", files, n: 2, t: 1, pool: "tidepool" }]);
    const more = page.locator(`${TILES} .tile-more`);
    await expect(more).toBeVisible();
    await expect(more).toContainText("more");
    // the measured capacity settles as the scroll box reports its real size — sample until stable
    const tileCount = () => page.locator(`${TILES} .tile`).count();
    const stableCount = async () => {
      let a = -1;
      let b = await tileCount();
      while (a !== b) {
        await page.waitForTimeout(150);
        a = b;
        b = await tileCount();
      }
      return b;
    };
    const shownCount = await stableCount();
    expect(shownCount).toBeLessThan(33);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    // the full list: 31 tiles + 2 labels + the toggle cell
    await expect(page.locator(`${TILES} .tile`)).toHaveCount(34);
    await more.click();
    expect(await stableCount()).toBe(shownCount);
  });

  test("CO27/3.9/3.11: a tile's menu offers Who relies and Why, reporting through the region", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, LANDED_IX_1);
    const fish = page.locator(`${TILES} .tile`, { hasText: "fish" });
    await fish.click();
    await expect(page.getByRole("menuitem", { name: "Who relies on this" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Why (newest change)" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Who relies on this" }).click();
    await expect.poll(() => page.evaluate(() => (window as { tileWho?: string }).tileWho)).toBe("creatures/fish.js");
    await fish.click();
    await page.getByRole("menuitem", { name: "Why (newest change)" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as { tileWhy?: { path: string; seq: number } }).tileWhy))
      .toEqual({ path: "creatures/fish.js", seq: 1 });
  });

  test("2.9: below 1100 the tiles sit behind the tiles.files disclosure", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await serveHarness(page);
    await sendEvents(page, LANDED_IX_1);
    const toggle = page.getByRole("button", { name: "Files", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`${TILES} .tile`, { hasText: "fish" })).toBeVisible();
  });
});
