// AC25 and FR30: the client routes. `/` shows the default pool of `/floor.json`
// ("tidepool"); `/p/{pool}` shows that pool as the main pool. A pool the stream does not
// answer (404 `not_found` on the stream probe) shows `pool.missing` and the way back to
// the default pool. `/replay/{id}` of an unknown recording shows `replay.error` and
// `replay.to_live`.

import { expect, test } from "@playwright/test";

test.describe("client routes (AC25)", () => {
  test("/ shows the default pool of /floor.json", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".pool-name")).toHaveText("tidepool");
  });

  test("/p/{pool} shows that pool as the main pool", async ({ page }) => {
    await page.goto("/p/tidepool-auto");
    await expect(page.locator(".pool-name")).toHaveText("tidepool-auto");
  });
});

test.describe("pool.missing (FR30)", () => {
  test("a pool the stream does not answer shows pool.missing and the way to the default pool", async ({ page }) => {
    // The Floor's probe is a plain GET on the stream route; a real pool answers 200, an
    // unknown one 404 with the API's error shape {"error":{"code":"not_found"}} (the Floor's own
    // body, src/worker/floor/floor-do.ts). Only the second may show pool.missing.
    await page.route("**/api/pools/ghost/stream", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' }),
    );
    await page.goto("/p/ghost");
    await expect(page.getByTestId("pool-missing")).toBeVisible();
    await expect(page.getByTestId("pool-missing")).toContainText("There is no pool at this address.");
    await page.getByRole("button", { name: "Open the default pool" }).click();
    await expect(page.locator(".pool-name")).toHaveText("tidepool");
    await expect(page).toHaveURL("/");
  });

  test("a pool whose probe does not answer 404 is not pool.missing", async ({ page }) => {
    // The dev fixture has no API: the probe fails to connect, which is `banner.offline`
    // after the wait, never pool.missing (FR30).
    await page.goto("/p/anything");
    await page.waitForTimeout(500);
    await expect(page.getByTestId("pool-missing")).toHaveCount(0);
    await expect(page.locator(".pool-name")).toHaveText("anything");
  });
});

test.describe("/replay/{id} of an unknown recording", () => {
  test("shows replay.error and replay.to_live", async ({ page }) => {
    await page.goto("/replay/no-such-recording");
    await expect(page.locator(".banner[data-tone='replay']")).toBeVisible();
    await expect(page.locator(".missing-pool")).toContainText("could not be downloaded");
    await page.getByRole("button", { name: "Open the live Floor" }).click();
    await expect(page).toHaveURL("/");
  });
});
