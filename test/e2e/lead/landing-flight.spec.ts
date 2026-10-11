// 6.4 (the landing moment): when `landing.landed` arrives, a chip travels from the change's card to
// the pool frame and one ring crosses the frame's water; nothing travels on a page that opens on
// landings it already has, nor with reduced motion.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const C04 = readFileSync(join(import.meta.dirname, "../../fixtures/streams/hero-c04.ndjson"), "utf8");
const POOL = "testpool";
const FLOOR_JSON = {
  default_pool: POOL,
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: false, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: {},
  limits: [],
  related: "",
};

type Frame = Record<string, unknown>;

const ALL: Frame[] = C04.trim()
  .split("\n")
  .slice(1)
  .map((line) => JSON.parse(line) as Frame);
const FIRST_LANDED = ALL.find((frame) => frame.type === "landing.landed")!.n as number;

async function serve(page: Page, initial: Frame[], delayed: Frame[]): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      ws.send(JSON.stringify({ events: initial }));
      if (delayed.length > 0) setTimeout(() => ws.send(JSON.stringify({ events: delayed })), 2_000);
    });
  });
}

/** Every chip and ring element the page adds, recorded as it appears. */
async function watch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { seen: string[] }).seen = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && /landing-(chip|ring)/.test(node.className))
            (window as unknown as { seen: string[] }).seen.push(node.className);
    }).observe(document, { childList: true, subtree: true });
  });
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);

test("6.4: a new landing sends a chip to the pool frame and rings its water once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await watch(page);
  const before = ALL.filter((frame) => (frame.n as number) < FIRST_LANDED);
  const landed = ALL.filter((frame) => (frame.n as number) === FIRST_LANDED);
  await serve(page, before, landed);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".pf-body")).toBeVisible();
  await expect.poll(() => seen(page), { timeout: 10_000 }).toContain("landing-ring");
  // 6.4 / VD1: the moment ends - nothing stays on the page.
  await expect(page.locator(".landing-chip, .landing-ring")).toHaveCount(0, { timeout: 3_000 });
});

test("6.4: a page that opens on landings it already has sends nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await watch(page);
  await serve(page, ALL, []);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".pf-body")).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(await seen(page)).toEqual([]);
});

test("6.4 reduced: with reduced motion nothing travels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await watch(page);
  const before = ALL.filter((frame) => (frame.n as number) < FIRST_LANDED);
  const landed = ALL.filter((frame) => (frame.n as number) === FIRST_LANDED);
  await serve(page, before, landed);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText("1", {
    timeout: 10_000,
  });
  await page.waitForTimeout(1_000);
  expect(await seen(page)).toEqual([]);
});
