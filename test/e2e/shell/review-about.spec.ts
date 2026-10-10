import { expect, test } from "@playwright/test";
import type { Features } from "../../../src/protocol/floor-json.ts";
import { limitsList } from "../../../src/config/limits.ts";
import { FEATURES } from "../../../src/config/features.ts";
import { FLOOR_JSON, POOL, ev, poolState, serveStream } from "./stream.ts";
import type { Frame } from "./stream.ts";
for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test(`D30 3.19 5.12: About has seven boxes in three columns at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await serveStream(page, [poolState(1)]);
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "About", exact: true }).click();
    const sheet = page.locator(".about-sheet");
    await expect(sheet).toContainText("Repair time with real agents: median –, p90 –.");
    await expect(sheet).toContainText("Attempt repositories are not provisioned in this build.");
    await expect(sheet.locator(".about-box")).toHaveCount(7);
    // D34 FL5: rule ids are not part of the visible key instructions.
    await expect(sheet.locator(".shortcut-table")).not.toContainText("RY26");
    expect(
      await sheet
        .locator(".about-box")
        .evaluateAll((boxes) => boxes.every((box) => Number.parseFloat(getComputedStyle(box).borderTopWidth) >= 1)),
    ).toBe(true);
    expect(
      await sheet
        .locator(".about-columns")
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
    ).toBe(3);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  });
}

test("N12 FJ1 14.8 3.19 5.12: About follows enabled attempt-repository results and limits", async ({ page }) => {
  const features: Features = { ...FEATURES, ...FLOOR_JSON.features, green: "none", attempt_repos: true };
  const settings = { ...FLOOR_JSON, features, limits: limitsList(features) };
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(settings) }),
  );
  let sendEvents: (events: Frame[]) => void = () => {
    throw new Error("the stream has not connected");
  };
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    sendEvents = (events) => ws.send(JSON.stringify({ events }));
    ws.onMessage((message) => {
      if ((JSON.parse(message.toString()) as { hello?: number }).hello === 1) sendEvents([poolState(1)]);
    });
  });
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "About", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "About this run", exact: true });
  await expect(sheet).toContainText("Attempt repositories: not reported by this build.");
  await expect(sheet.locator(".about-how")).toContainText("one repository per attempt for its conversation");
  await expect(sheet.locator(".about-limits")).not.toContainText("attempt repositories");
  sendEvents([
    ev(2, { type: "attempt.repo", src: "agent", attempt_id: "a_1", ts: 2_000, ok: true, ms: 100, error: null }),
  ]);
  await expect(sheet).toContainText("Attempt repositories: – per second, 0% failed. No landing waits for one.");
  sendEvents([
    ev(3, { type: "attempt.repo", src: "agent", attempt_id: "a_2", ts: 4_000, ok: false, ms: 200, error: "timeout" }),
  ]);
  await expect(sheet).toContainText("Attempt repositories: 0.50 per second, 50% failed. No landing waits for one.");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
});
