import { expect, test } from "@playwright/test";
import { attempts, attemptOpened, attemptState, intentCreated, serveReview } from "./review-fixtures.ts";

for (const { count, focus } of [
  { count: 1, focus: 1 },
  { count: 5, focus: 5 },
  { count: 5, focus: 2 },
  { count: 12, focus: 6 },
]) {
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
  ]) {
    test(`D24 / VD14: inserting an attempt preserves the focused card position at ${size.width} with ${count} cards focused on ${focus}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const send = await serveReview(page, attempts(count));
      await page.goto("/p/testpool");
      const card = page.locator(`[data-attempt-id="a_${focus}"]`);
      await card.focus();
      await card.scrollIntoViewIfNeeded();
      const before = (await card.boundingBox())!;
      send([
        intentCreated(100, "i_new", "a new creature"),
        attemptOpened(101, "a_new", "i_new"),
        attemptState(102, "a_new", "opened", "working"),
      ]);
      await expect(page.locator('[data-attempt-id="a_new"]')).toHaveCount(1);
      await expect(card).toBeFocused();
      await expect.poll(async () => Math.abs((await card.boundingBox())!.y - before.y)).toBeLessThanOrEqual(1);
    });
  }
}
