// The Compare view in the assembled page (03-floor 2.3, 6.6). The pool area lane's own spec
// mounts the registered component on a harness page; this one proves the shell shows it: the
// Compare button and key C open it, Back and Escape return to the Floor view, and a pool with
// no plain-merge remote offers neither the button nor the view.

import { expect, test } from "@playwright/test";
import { serveStream, poolState, intentCreated, attemptOpened } from "./stream.ts";

const PLAIN = { plain_remote: "https://artifacts.invalid/testpool-plain" };

test.describe("the Compare view in the page (2.3)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test("the Compare button opens it, Back closes it", async ({ page }) => {
    await serveStream(page, [poolState(1, PLAIN), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const compare = page.locator(".floor-compare");
    await expect(compare).toBeVisible();
    await expect(compare.locator('.cmp-col[data-pool="main"]')).toBeVisible();
    await expect(compare.locator('.cmp-col[data-pool="plain"]')).toBeVisible();
    // The Floor view's regions are gone while Compare shows; header and strip stay (2.3).
    await expect(page.locator(".rail")).toHaveCount(0);
    await expect(page.locator(".strip")).toBeVisible();
    await compare.locator(".cmp-back").click();
    await expect(page.locator(".floor-compare")).toHaveCount(0);
    await expect(page.locator(".rail")).toBeVisible();
  });

  test("key C opens it and Escape returns to the Floor view (6.6)", async ({ page }) => {
    await serveStream(page, [poolState(1, PLAIN), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    // C acts once the pool's plain-merge remote is known - the moment the button appears.
    await expect(page.getByRole("button", { name: "Compare", exact: true })).toBeVisible();
    await page.keyboard.press("c");
    await expect(page.locator(".floor-compare .cmp")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".floor-compare")).toHaveCount(0);
    await expect(page.locator(".rail")).toBeVisible();
  });

  test("a pool with no plain-merge remote has no Compare button and no view", async ({ page }) => {
    await serveStream(page, [poolState(1), intentCreated(2), attemptOpened(3)]);
    await page.goto(`/p/testpool`);
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare", exact: true })).toHaveCount(0);
    await page.keyboard.press("c");
    await expect(page.locator(".floor-compare")).toHaveCount(0);
    await expect(page.locator(".rail")).toBeVisible();
  });
});
