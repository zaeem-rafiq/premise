// VE8 tile regressions on the assembled Floor, with the pool frame stubbed as in lead/look.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { attemptOpened, ev, intentCreated, poolState, serveSession, serveStream } from "../shell/stream.ts";

// Use the actual seed tree from the recorded demo, not a reduced file list that hides overflow,
// plus the creatures the demo lands (1.2, beats 1 to 5). The seed tree alone is 26 cells, which
// the stage grid's three rows of nine now hold whole (2.1: the tiles get the pool area's rest).
const seedFiles = [
  ...(readFileSync("public/replay/hero-canned.ndjson", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.type === "pool.files")!.files as Array<Record<string, unknown>>),
  ...["crab", "jellyfish", "shrimp", "squid"].map((name) => ({ path: `creatures/${name}.js`, tier: "auto" })),
];

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool frame stub</title><script>
  var part = location.pathname.split("/")[3];
  var v = "c-seed";
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "advance") v = e.data.version;
  });
  function beat() {
    parent.postMessage({ type: "stats", source: part, version: v, seq: 0,
      tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
  }
  beat(); setInterval(beat, 200);
</script>`;

async function openTiles(page: Page, width: number, height: number, theme: "dark" | "light") {
  await page.setViewportSize({ width, height });
  await page.addInitScript((value) => localStorage.setItem("premise.theme", value), theme);
  await serveSession(page, false);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await serveStream(page, [
    poolState(1, { app: "tidepool" }),
    ev(2, { type: "pool.files", files: seedFiles }),
    intentCreated(3, "i_1", "make energy a fraction"),
    attemptOpened(4),
    ev(5, {
      type: "premise.recorded",
      attempt_id: "a_1",
      tool: "read",
      premise: {
        kind: "entity",
        key: "world/energy.js#ENERGY_MAX",
        hash: "h-energy",
        seq: 0,
        read: true,
        edit: false,
        derived: false,
      },
    }),
    ev(6, {
      type: "op.recorded",
      attempt_id: "a_1",
      op_seq: 1,
      op: "replace",
      path: "world/energy.js",
      targets: ["world/energy.js#ENERGY_MAX"],
      altered: ["world/energy.js#ENERGY_MAX"],
      added: [],
      removed: [],
    }),
  ]);
  await page.goto("/");
  await expect(page.locator(".tiles .tile-more")).toBeVisible();
}

for (const [size, width, height] of [
  ["stage", 1920, 1080],
  ["laptop", 1440, 900],
] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`D21 VD11/5.3/6.3: Held uses the waiting-for-owner colour at ${size} ${theme}`, async ({ page }) => {
      await openTiles(page, width, height, theme);
      const held = page.locator('.tile[title="world/energy.js"] .tile-tag');
      const expected = theme === "dark" ? "rgb(255, 200, 87)" : "rgb(138, 90, 0)";
      await expect(held).toHaveText("Held");
      await expect(held).toHaveCSS("color", expected);
      await expect(held).toHaveCSS("border-top-color", expected);
      await page.screenshot({ path: `.tmp-test/review-held-${size}-${theme}.png` });
    });

    test(`D17 2.2/3.7/CO28: energy is visible before overflow at ${size} ${theme}`, async ({ page }) => {
      await openTiles(page, width, height, theme);
      const tiles = page.locator(".tiles");
      const energy = tiles.getByRole("button", { name: "world/energy.js. 1 reading, 1 writing.", exact: true });
      await expect(tiles).toHaveAttribute("data-open", "false");
      await expect(energy).toBeInViewport({ ratio: 1 });
      const energyBox = await energy.boundingBox();
      const scrollBox = await tiles.locator(".tiles-scroll").boundingBox();
      expect(energyBox).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(energyBox!.y).toBeGreaterThanOrEqual(scrollBox!.y);
      expect(energyBox!.y + energyBox!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height + 1);
      await expect(energy.locator(".tile-mark-r")).toHaveCount(1);
      await expect(energy.locator(".tile-mark-w")).toHaveCount(1);
      await expect(tiles.locator(".tile").last()).toHaveClass(/tile-more/);
      await page.screenshot({ path: `.tmp-test/review-visible-energy-${size}-${theme}.png` });
      await energy.click();
      await page.getByRole("menuitem", { name: "Who relies on this" }).click();
      await expect(page.locator(".who-sheet")).toBeVisible();
      await expect(page.locator(".who-sheet")).toContainText("ENERGY_MAX");
      await page.locator(".who-sheet").getByRole("button", { name: "ENERGY_MAX", exact: true }).click();
      await expect(page.locator(".who-sheet")).toContainText("In flight (1)");
      await page.keyboard.press("Escape");
      await tiles.locator(".tile-more").click();
      await expect(tiles).toHaveAttribute("data-open", "true");
      await expect(tiles.locator(".tile-name", { hasText: /^policy$/ })).toHaveCount(1);
    });

    test(`D16 CP1/FL5/3.7: root label fits and is accessible at ${size} ${theme}`, async ({ page }) => {
      await openTiles(page, width, height, theme);
      await page.locator(".tile-more").click();
      const root = page.locator(".tile-label", { hasText: "top-level files" });
      await root.scrollIntoViewIfNeeded();
      await expect(root).toBeInViewport({ ratio: 1 });
      await expect(root).not.toHaveAttribute("aria-hidden", "true");
      await expect(root.locator(".tile-name")).toHaveText("top-level files");
      expect(
        await root
          .locator(".tile-name")
          .evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight),
      ).toBe(true);
      await page.screenshot({ path: `.tmp-test/review-root-${size}-${theme}.png` });
    });
  }
}
