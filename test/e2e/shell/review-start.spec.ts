import { expect, test } from "@playwright/test";
import { POOL, poolState, serveSession, serveStream } from "./stream.ts";

test("D5 RY23: the quiet pool start card belongs only to visitors", async ({ page }) => {
  await serveStream(page, [poolState(1)]);
  await serveSession(page, false);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".start-card")).toBeVisible();
  await expect(page.locator(".start-card")).toContainText("This plays a recorded run");
  await expect(page.locator(".start-card")).not.toContainText("real recorded run");
  await page.getByRole("button", { name: "Visitor", exact: true }).click();
  await page.getByLabel("Owner key").fill("fixture-only");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Owner", exact: true })).toBeVisible();
  await expect(page.locator(".start-card")).toHaveCount(0);
});
