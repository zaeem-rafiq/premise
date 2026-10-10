// VE8 design-review regressions. The fixture server has no Worker: owner/session and
// stream routes are local fixtures, and pool frames speak the documented stats/probe
// channel. Layout numbers below are from 03-floor 2.1, 2.8, LY3, LY5 and CO15 (BP1).

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  FLOOR_JSON,
  POOL,
  attemptOpened,
  attemptState,
  ev,
  intentCreated,
  limits,
  metrics,
  poolState,
  serveSession,
  serveStream,
  type Frame,
} from "./stream.ts";

const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
] as const;
const THEMES = ["dark", "light"] as const;
const PREWRITTEN = {
  id: "A01",
  text: "a jellyfish that drifts up and down",
  group: "starter",
  race: false,
};
const SETTINGS = { ...FLOOR_JSON, prewritten: [PREWRITTEN] };

// Like lead/look.spec.ts, this host is deliberately a frame-channel stub. It proves
// layout and parent-page interaction, not the real pool's self-test or animation.
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool fixture</title>
<style>html,body{height:100%;margin:0;background:#2b5466}</style><script>
  var source = location.pathname.split("/")[3];
  var version = source === "plain" ? "p-plain-seed" :
    source === "main" || source === "green" ? "c-c-seed" : source;
  var selftest = null;
  var paused = new URLSearchParams(location.search).get("paused") === "1";
  function stats() {
    parent.postMessage({type:"stats",source:source,version:version,seq:0,tick:1,
      paused:paused,kinds:{},shown:0,total:0,swap:null,selftest:selftest}, "*");
  }
  window.addEventListener("message", function(event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "pause") paused = true;
    if (message.type === "resume") paused = false;
    if (message.type === "advance") { version = message.version; selftest = null; }
    if (message.type === "probe" && message.selftest === true)
      selftest = {version:version,ok:true,failed:[]};
    stats();
  });
  stats();
  setInterval(stats, 200);
</script>`;

function liveFrames(attempts = 1): Frame[] {
  let n = 1;
  const frames = [
    poolState(n++, {
      app: "tidepool",
      plain_remote: "https://artifacts.invalid/testpool-plain",
      real_agents: attempts,
      max_real_agents: 12,
    }),
  ];
  for (let i = 1; i <= attempts; i += 1) {
    frames.push(
      intentCreated(n++, `i_${i}`, `a tracer fish ${i}`),
      attemptOpened(n++, `a_${i}`, `i_${i}`),
      attemptState(n++, `a_${i}`, "opened", "working"),
    );
    for (const key of ["world/energy.js#ENERGY_MAX", "world/bounds.js#FLOOR_Y"]) {
      frames.push(
        ev(n++, {
          type: "premise.recorded",
          attempt_id: `a_${i}`,
          premise: { kind: "entity", key, hash: "h0", seq: 0, read: true, edit: false, derived: false },
          tool: "read",
        }),
      );
    }
  }
  frames.push(
    limits(n++, { spend: 1.84, cap: 40 }),
    metrics(n++),
    ev(n++, {
      type: "plain.updated",
      commit: "plain-seed",
      tree: "plain-tree",
      through_seq: 0,
      skipped: [],
      interrupted: [],
    }),
  );
  return frames;
}

async function prepare(page: Page, width: number, height: number, silentFrame = false): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem("premise.theme", "dark"));
  await page.route("**/pool/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: silentFrame ? "<!doctype html><title>unavailable pool</title>" : POOL_PAGE,
    }),
  );
}

async function openOwner(page: Page, attempts = 1): Promise<void> {
  await serveSession(page, true);
  await serveStream(page, liveFrames(attempts), [], SETTINGS);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".intent-prewritten")).toBeEnabled();
  await expect(page.locator(".pool-area .pf-body iframe")).toBeVisible();
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function assertTargets(locator: Locator): Promise<void> {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const target = await box(locator.nth(i));
    expect(target.width, `target ${i} width`).toBeGreaterThanOrEqual(44);
    expect(target.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
  }
}

for (const size of SIZES) {
  test(`D41 / 2.1, AC12, LY5: the caption is 40 px and its controls work at ${size.width}`, async ({ page }) => {
    await prepare(page, size.width, size.height);
    await openOwner(page);
    const caption = page.locator(".pool-area .pf-caption");
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const captionBox = await box(caption);
      const frameBox = await box(page.locator(".pool-area .pf-body"));
      expect(Math.abs(captionBox.height - 40), `${theme}: caption height`).toBeLessThanOrEqual(1);
      expect(
        Math.abs(frameBox.y - captionBox.y - captionBox.height),
        `${theme}: frame follows caption`,
      ).toBeLessThanOrEqual(1);
      await assertTargets(caption.locator("button"));
    }
    await caption.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(caption.getByRole("button", { name: "Play", exact: true })).toHaveAttribute("aria-pressed", "true");
    await caption.getByRole("button", { name: "Play", exact: true }).click();
    await expect(caption.getByRole("button", { name: "Pause", exact: true })).toHaveAttribute("aria-pressed", "false");
    await caption.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".cmp")).toBeVisible();
  });
}

test("D33 / 2.8, 3.8: laptop strip values stay on one line without clipping", async ({ page }) => {
  await prepare(page, 1440, 900);
  await openOwner(page);
  await expect(page.locator('.strip-cell[data-cell="strip.green"]')).toContainText("not running in this build");
  await expect(page.locator('.strip-cell[data-cell="strip.spend"]')).toContainText("$1.84 of $40.00");
  for (const theme of THEMES) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const values = await page.locator(".strip-value").evaluateAll((elements) =>
      elements.map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        const cell = element.closest(".strip-cell")!.getBoundingClientRect();
        return {
          text: element.textContent,
          lines: rects.length,
          fits: rects.every(
            (rect) =>
              rect.left >= cell.left && rect.right <= cell.right && rect.top >= cell.top && rect.bottom <= cell.bottom,
          ),
        };
      }),
    );
    expect(values).toHaveLength(7);
    for (const value of values) {
      expect(value.lines, `${theme}: ${value.text}`).toBe(1);
      expect(value.fits, `${theme}: ${value.text} fits its cell`).toBe(true);
    }
    expect(Math.abs((await box(page.locator(".strip"))).height - 60)).toBeLessThanOrEqual(1);
  }
});

for (const width of [320, 768, 1100, 1280, 1440, 1600, 1920]) {
  test(`D25 / LY3, AC13: the owner's live page fits ${width} px and can send`, async ({ page }) => {
    await prepare(page, width, 900);
    await openOwner(page);
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const layout = await page.evaluate(() => ({
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
        controls: [...document.querySelectorAll(".intent-row button, .intent-row select")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.textContent, left: rect.left, right: rect.right };
        }),
      }));
      expect(layout.overflow, `${theme}: page overflow`).toBeLessThanOrEqual(0);
      expect(layout.controls.length).toBeGreaterThanOrEqual(3);
      for (const control of layout.controls) {
        expect(control.left, `${theme}: ${control.name} left edge`).toBeGreaterThanOrEqual(0);
        expect(control.right, `${theme}: ${control.name} right edge`).toBeLessThanOrEqual(width);
      }
    }
    await page.route(`**/api/pools/${POOL}/intents`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ intent_id: "i_new" }),
      }),
    );
    await page.locator(".intent-prewritten").selectOption(PREWRITTEN.id);
    await expect(page.locator(".intent-field")).toHaveValue(PREWRITTEN.text);
    const posted = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === `/api/pools/${POOL}/intents`,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await posted).postDataJSON()).toMatchObject({ text: PREWRITTEN.text, race: false, prewritten: true });
  });
}

test("D39 / CO25a, FL10: Floor has no self-test badge and Compare keeps both below the frames", async ({ page }) => {
  await prepare(page, 1920, 1080);
  await openOwner(page);
  await expect(page.locator(".pool-area .pf-overlay")).toHaveCount(0);
  await expect(page.locator(".pool-area .pf-selftest")).toHaveCount(0);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.locator(".cmp .pf-selftest")).toContainText("passed");
  await expect(page.locator(".cmp .plf-selftest")).toContainText("passed");
  for (const [body, badge] of [
    [".pf-body", ".pf-selftest"],
    [".plf-body", ".plf-selftest"],
  ]) {
    const frameBox = await box(page.locator(`.cmp ${body}`));
    const badgeBox = await box(page.locator(`.cmp ${badge}`));
    expect(badgeBox.y).toBeGreaterThanOrEqual(frameBox.y + frameBox.height);
  }
  await page.locator(".cmp-back").click();
  await expect(page.locator(".pool-area .pf-selftest")).toHaveCount(0);
});

test("D39 / CO25a, FL10: a failed Floor frame has a reload sentence and no running self-test badge", async ({
  page,
}) => {
  await prepare(page, 1440, 900, true);
  await openOwner(page);
  await expect(page.locator(".pool-area .pf-overlay")).toContainText("The pool did not load.", { timeout: 12_000 });
  await expect(page.getByRole("button", { name: "Reload the pool", exact: true })).toBeVisible();
  await expect(page.locator(".pool-area .pf-selftest")).toHaveCount(0);
});

for (const size of SIZES) {
  for (const attempts of [1, 6]) {
    test(`D40 / LY5, CO15: ${attempts === 1 ? "full" : "compact"} lights and the prewritten menu have 44 px targets at ${size.width}`, async ({
      page,
    }) => {
      await prepare(page, size.width, size.height);
      await openOwner(page, attempts);
      const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
      const lights = card.locator(".attempt-card__lights .light");
      await expect(lights).toHaveCount(2);
      await assertTargets(lights);
      await assertTargets(page.locator(".intent-prewritten"));
      // Both rectangles in one frame: measured one after the other, a card still settling moves
      // between the two reads and the pair looks overlapped by a pixel or two.
      const [first, second] = await lights.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, width: r.width };
        }),
      );
      expect(second!.x).toBeGreaterThanOrEqual(first!.x + first!.width);
      for (const svg of await lights.locator("svg").all()) {
        const drawn = await box(svg);
        expect(drawn.width).toBe(attempts === 1 ? 28 : 20);
        expect(drawn.height).toBe(attempts === 1 ? 28 : 20);
      }
      await lights.nth(0).focus();
      await page.keyboard.press("Tab");
      await expect(lights.nth(1)).toBeFocused();
      await page.locator(".intent-prewritten").selectOption(PREWRITTEN.id);
      await expect(page.locator(".intent-field")).toHaveValue(PREWRITTEN.text);
    });
  }
}
