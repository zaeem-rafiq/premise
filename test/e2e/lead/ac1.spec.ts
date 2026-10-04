// AC1 on the real page (FE3): one recorded file gives the same picture through the live
// path (every event from 1), a join from a mid-stream snapshot plus the rest, and Replay
// to the end. Compared: the strip's counters, every card's status word and lights, and
// the file tiles. The run clock is excluded - it reads a clock, not the stream.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { emptyFloorState, reduce } from "../../../src/protocol/reducer/index.ts";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import { FLOOR_JSON, serveSession } from "../shell/stream.ts";

const NDJSON = readFileSync(join(import.meta.dirname, "../../fixtures/streams/hero-c04.ndjson"), "utf8");
const EVENTS = NDJSON.trim()
  .split("\n")
  .slice(1)
  .map((line) => JSON.parse(line) as PoolEvent);

const MID = 24; // snapshot joins just before the first landing lands (n=25+)
const FLOOR = { ...FLOOR_JSON, default_pool: "tidepool" };

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

async function serveLive(page: Page, frames: object[]): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR) }),
  );
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      for (const frame of frames) ws.send(JSON.stringify(frame));
    });
  });
  await serveSession(page, false);
}

/** The strip's label -> value map minus the run clock; the rail's cards with status word
 * and lights; the tiles' names and marks. */
async function picture(page: Page) {
  const cells: Record<string, string> = {};
  for (const cell of await page.locator(".strip-cell").all()) {
    const label = (await cell.locator(".strip-label").innerText()).trim();
    if (label === "Run clock") continue;
    cells[label] = (await cell.locator(".strip-main").innerText()).replace(/\s+/g, " ").trim();
  }

  await page.locator(".tabs button", { hasText: "Landed" }).click();
  const cards: Array<{ intent: string; status: string; lights: string }> = [];
  for (const card of await page.locator(".rail-list .attempt-card").all()) {
    const lightClasses = await card
      .locator(".light")
      .evaluateAll((els) => els.map((el) => el.className.replace(/light--list|light/g, "").trim()).sort());
    cards.push({
      intent: (await card.locator(".attempt-card__intent").innerText()).trim(),
      status: (await card.locator(".attempt-card__word").innerText()).trim(),
      lights: lightClasses.join(","),
    });
  }
  cards.sort((a, b) => a.intent.localeCompare(b.intent));

  const tiles = await page.locator(".tiles-grid .tile").evaluateAll((els) =>
    els
      .map((el) => ({
        name: (el.querySelector(".tile-name")?.textContent ?? "").trim(),
        label: el.classList.contains("tile-label"),
        r: el.querySelectorAll(".tile-mark-r").length,
        w: el.querySelectorAll(".tile-mark-w").length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  return { cells, cards, tiles };
}

test("AC1: live, snapshot-join and Replay draw the same page", async ({ browser }) => {
  const pictures = [];

  // 1) live stream from event 1.
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await serveLive(page, [{ events: EVENTS }]);
    await page.goto("/");
    await expect(page.locator(".rail")).toBeVisible();
    await dismissStart(page);
    await expect(page.locator(".tabs button", { hasText: "Landed 2" })).toBeVisible();
    pictures.push(await picture(page));
    await page.close();
  }

  // 2) a snapshot at MID, then the rest of the events.
  {
    const midState = emptyFloorState();
    for (const event of EVENTS.slice(0, MID)) reduce(midState, event);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await serveLive(page, [
      { snapshot: { n: EVENTS[MID - 1]!.n, state: JSON.parse(JSON.stringify(midState)) } },
      { events: EVENTS.slice(MID) },
    ]);
    await page.goto("/");
    await expect(page.locator(".rail")).toBeVisible();
    await dismissStart(page);
    await expect(page.locator(".tabs button", { hasText: "Landed 2" })).toBeVisible();
    pictures.push(await picture(page));
    await page.close();
  }

  // 3) Replay to the end.
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
    await page.goto("/replay/hero-c04");
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 20_000 });
    pictures.push(await picture(page));
    await page.close();
  }

  expect(pictures[1], "snapshot-join vs live").toEqual(pictures[0]);
  expect(pictures[2], "replay vs live").toEqual(pictures[0]);
});
