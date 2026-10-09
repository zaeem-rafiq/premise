import { expect, test } from "@playwright/test";
import { POOL, poolState, serveSession, serveStream } from "./stream.ts";

test("D29 AX13 FA4: A and R work from buttons, including inside About", async ({ page }) => {
  await serveStream(page, [poolState(1)]);
  await serveSession(page, true);
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "Owner", exact: true }).focus();
  await page.keyboard.press("a");
  await expect(page.locator(".about-sheet")).toBeVisible();
  await page.locator(".about-sheet .sheet-actions button").focus();
  await page.keyboard.press("r");
  await expect(page).toHaveURL(/\/replay\//);
  await expect(page.locator(".replay-bar").getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("D29 AX13: typing in every kind of field never invokes a shortcut", async ({ page }) => {
  await serveStream(page, [poolState(1)]);
  await serveSession(page, true);
  await page.goto(`/p/${POOL}`);
  for (const tag of ["input", "textarea", "select", "editable"]) {
    await page.evaluate((tag) => {
      const field = document.createElement(tag === "editable" ? "div" : tag);
      if (tag === "editable") field.contentEditable = "true";
      field.id = "shortcut-field";
      document.body.append(field);
      field.focus();
    }, tag);
    await page.keyboard.press("a");
    await page.keyboard.press("r");
    await expect(page).toHaveURL(new RegExp(`/p/${POOL}$`));
    await expect(page.locator(".about-sheet")).toHaveCount(0);
    await page.locator("#shortcut-field").evaluate((node) => node.remove());
  }
});
