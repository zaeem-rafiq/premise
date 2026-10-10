// AC14: the premise lights of 03-floor 3.3 over the hero recordings' own events, sent through
// the live-stream mock in the recording's order. In hero-c04 the shared rule lands first, so
// the creature card's `world/energy.js#ENERGY_MAX` light turns `changed` at that landing and
// returns to `holds` at the resolving submit; hero-c05 is the mirror on the shared-rule card's
// `refs:` query premise. (Replay seek is out of the rail lane: the shell's session keeps the
// pre-seek floor after a rebuild, so the recording's events go over the WebSocket instead.)
// Expected words are the 5.3 light words, not the page's (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const C04 = readFileSync(join(import.meta.dirname, "../../fixtures/streams/hero-c04.ndjson"), "utf8");
const C05 = readFileSync(join(import.meta.dirname, "../../fixtures/streams/hero-c05.ndjson"), "utf8");

const POOL = "testpool";

const FLOOR_JSON = {
  default_pool: POOL,
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: true, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: { "model-a": "model-a" },
  limits: [],
  related: "",
};

type Frame = Record<string, unknown>;

/** The recording's events as protocol frames (line 1 is the recording header). */
function frames(body: string): Frame[] {
  return body
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Frame);
}

function between(all: Frame[], lo: number, hi: number): Frame[] {
  return all.filter((frame) => (frame.n as number) > lo && (frame.n as number) <= hi);
}

/** Serves `/floor.json` and answers the stream socket with `initial`, then `delayed` after 3s. */
async function serveStream(page: Page, initial: Frame[], delayed: Frame[]): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      ws.send(JSON.stringify({ events: initial }));
      if (delayed.length > 0) {
        setTimeout(() => {
          ws.send(JSON.stringify({ events: delayed }));
        }, 3_000);
      }
    });
  });
}

test.describe("AC14: a light is changed at the landing, holds at the resolving submit", () => {
  test.describe.configure({ timeout: 120_000 });

  // hero-c04: premise.judged (ENERGY_MAX, repair) is n=28, inside the shared rule's landing
  // window; headsup.resolved is n=37 and the resolving submit.result is n=38.
  test("hero-c04: ENERGY_MAX on the creature's card (a_A) is changed after landing 1, holds after the resolving submit", async ({
    page,
  }) => {
    const all = frames(C04);
    await serveStream(page, between(all, 0, 34), between(all, 34, 38));
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_A"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // The strip light (the expanded relies-on list repeats it as a `.light--list` row).
    const strip = card.locator(".attempt-card__lights");
    await expect(strip.locator('.light--changed[aria-label*="ENERGY_MAX"]')).toBeVisible();
    await expect(strip.locator('.light--holds[aria-label*="ENERGY_MAX"]')).toBeVisible({ timeout: 15_000 });
    await expect(strip.locator('.light--changed[aria-label*="ENERGY_MAX"]')).toHaveCount(0);
  });

  // hero-c05 (mirror): premise.judged (refs:world/energy.js#ENERGY_MAX, repair) is n=28 on the
  // shared-rule card a_S; headsup.resolved is n=40 and the resolving submit.result is n=41.
  test("hero-c05: the shared-rule card's refs: premise on ENERGY_MAX is changed after landing 1, holds after the resolving submit", async ({
    page,
  }) => {
    const all = frames(C05);
    await serveStream(page, between(all, 0, 34), between(all, 34, 41));
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_S"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Only one strip light on a_S is changed then: the `refs:` query premise on ENERGY_MAX.
    const strip = card.locator(".attempt-card__lights");
    await expect(strip.locator(".light--changed")).toHaveCount(1);
    await expect(strip.locator('.light--changed[aria-label*="ENERGY_MAX"]')).toBeVisible();
    await expect(strip.locator(".light--changed")).toHaveCount(0, { timeout: 15_000 });
    // The `refs:` premise's label is "the list of code that uses ENERGY_MAX in world/energy.js".
    // CO14a: a_S now holds more than 3 premises, so the strip counts them; the expanded card's
    // relies-on list still names this one.
    await expect(card.locator(".attempt-card__holds")).toBeVisible();
    if ((await card.getAttribute("aria-expanded")) !== "true") await card.click();
    await expect(card).toHaveAttribute("aria-expanded", "true");
    await expect(
      card.locator('.light--list.light--holds[aria-label*="the list of code that uses ENERGY_MAX"]'),
    ).toBeVisible();
  });
});
