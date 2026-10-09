import { expect, test } from "@playwright/test";
import { POOL, poolState, attemptOpened, attemptState, intentCreated, serveStream } from "./stream.ts";

test("D20 3.19 LY2 FR4: failure toasts reserve space and leave on Replay", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveStream(
    page,
    [poolState(1), intentCreated(2), attemptOpened(3)],
    [attemptState(4, "a_1", "opened", "stopped", { reason: "model_error" })],
  );
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator(".toast")).toBeVisible();
  const bounds = await page.evaluate(() => ({
    toast: document.querySelector(".toasts")!.getBoundingClientRect().toJSON(),
    main: document.querySelector(".floor-main")!.getBoundingClientRect().toJSON(),
  }));
  expect(bounds.toast.y).toBeGreaterThanOrEqual(bounds.main.bottom);
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await expect(page).toHaveURL(/\/replay\//);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("D20 FR4: a race choice does not toast a failure", async ({ page }) => {
  await serveStream(page, [
    poolState(1),
    intentCreated(2),
    attemptOpened(3),
    attemptState(4, "a_1", "opened", "stopped", { reason: "not_chosen" }),
  ]);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".rail")).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
});
