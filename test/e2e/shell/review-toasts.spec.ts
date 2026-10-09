import { expect, test } from "@playwright/test";
import { POOL, poolState, attemptOpened, attemptState, intentCreated, serveStream } from "./stream.ts";

test("D20 3.19 LY1 FR4: a failure toast floats bottom left, moves nothing, stays under every sheet and leaves on Replay", async ({
  page,
}) => {
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
    floor: document.querySelector(".floor")!.getBoundingClientRect().toJSON(),
    main: document.querySelector(".floor-main")!.getBoundingClientRect().toJSON(),
    toast: document.querySelector(".toasts")!.getBoundingClientRect().toJSON(),
    toastZ: Number(getComputedStyle(document.querySelector(".toasts")!).zIndex),
    sheetZ: Number(getComputedStyle(document.querySelector(".sheet-backdrop")!).zIndex),
  }));
  // 3.19 "bottom left"; LY1: the body keeps its full height, so a toast never resizes the frame or a sheet.
  expect(Math.abs(bounds.main.bottom - bounds.floor.bottom)).toBeLessThanOrEqual(1);
  expect(bounds.toast.bottom).toBeLessThanOrEqual(bounds.main.bottom);
  expect(bounds.toast.x).toBeLessThan(bounds.main.x + 40);
  // A sheet is never covered: the toasts stack under every sheet.
  expect(bounds.toastZ).toBeLessThan(bounds.sheetZ);
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
