// 2.11 (owner's design decision of 2026-10-10): the Overview view. A live page opens on it when
// `/floor.json` names it; its headline tells the same counters the Floor view's strip shows; keys
// O and F switch between the two; Replay and a settings file without the field open on the Floor.

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

function frames(body: string): Frame[] {
  return body
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Frame);
}

async function serve(page: Page, floorJson: Record<string, unknown>): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(floorJson) }),
  );
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      ws.send(JSON.stringify({ events: frames(C04) }));
    });
  });
}

test("2.11: a live page opens on the Overview; its headline tells the strip's counters; O and F switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serve(page, { ...FLOOR_JSON, default_view: "overview" });
  await page.goto(`/p/${POOL}`);

  const overview = page.locator(".overview");
  await expect(overview).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  // The strip steps aside; the header and the banners stay (FL4).
  await expect(page.locator(".strip")).toBeHidden();
  await expect(page.locator(".header")).toBeVisible();

  // The headline reads the 5.4 forms, and the facts line keeps the other strip cells.
  const title = page.locator(".overview__title");
  await expect(title).toHaveText(/^(\d+ changes? landed\. \d+ went around\.|No change has landed yet\.)$/, {
    timeout: 30_000,
  });
  await expect(page.locator(".overview__facts")).toContainText("Run clock");
  await expect(page.locator(".overview__facts")).not.toContainText("Landed");
  // A sub-line is set off by a dash, never run into its value (2.11).
  await expect(page.locator(".overview__facts")).not.toContainText(/\d Limit/);
  // At most three cards in flight (2.11).
  expect(await page.locator(".overview__card").count()).toBeLessThanOrEqual(3);

  // F opens the Floor view; its strip shows the same two numbers the headline told.
  const headline = (await title.textContent()) ?? "";
  await page.keyboard.press("f");
  await expect(page.locator(".rail")).toBeVisible();
  await expect(overview).toHaveCount(0);
  const landed = await page.locator('.strip-cell[data-cell="strip.landed"] .strip-value').textContent();
  const around = await page.locator('.strip-cell[data-cell="strip.goarounds"] .strip-value').textContent();
  if (landed !== "0") {
    expect(headline).toBe(`${landed} ${landed === "1" ? "change" : "changes"} landed. ${around} went around.`);
  }

  // O comes back.
  await page.keyboard.press("o");
  await expect(overview).toBeVisible();
  await page.locator(".overview__more").click();
  await expect(page.locator(".rail")).toBeVisible();
});

test("2.11: without default_view the page opens on the Floor view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serve(page, FLOOR_JSON);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".rail")).toBeVisible();
  await expect(page.locator(".overview")).toHaveCount(0);
});
