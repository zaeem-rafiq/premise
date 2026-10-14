// 09-try TY11 in the fixture project: the visitor's "Try it" button on the start card and on the
// Overview, its starting, refused and failed states, and who never sees it. `POST /api/try` is
// scripted here (the fixture project runs no Worker); the sentences are the copy table's
// (03-floor 5.4) and the 429 body is TY2's shape.

import { expect, test, type Page, type Route } from "@playwright/test";
import { FLOOR_JSON, POOL, poolState, serveSession, serveStream } from "../shell/stream.ts";

const BUTTON = "Try it: watch agents adapt live";
const STARTING = "Starting your own copy of the tide pool…";
const FAILED = "Try it could not start. Tap it again, or play the Replay.";
const LIMITED = "You started a try a few minutes ago. Open it again, or wait ten minutes.";

const WITH_TRY = { ...FLOOR_JSON, features: { ...FLOOR_JSON.features, try: true } };

async function visitor(page: Page, floor: Record<string, unknown> = WITH_TRY, owner = false): Promise<void> {
  await serveStream(page, [poolState(1)], [], floor);
  await serveSession(page, owner);
}

/** Answers `POST /api/try` once `release()` is called, so a test sees the starting state. */
async function holdTry(
  page: Page,
  answer: (route: Route) => Promise<void>,
): Promise<{ release(): void; calls(): number }> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.route("**/api/try", async (route) => {
    calls += 1;
    expect(route.request().method()).toBe("POST");
    await gate;
    await answer(route);
  });
  return { release: () => release(), calls: () => calls };
}

test("TY11: the start card offers Try it; a tap shows the starting sentence, then opens the try pool", async ({
  page,
}) => {
  await visitor(page);
  const pending = await holdTry(page, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ pool: "try-abc0123456", path: "/p/try-abc0123456" }),
    }),
  );
  await page.goto(`/p/${POOL}`);
  const card = page.locator(".start-card");
  await expect(card).toBeVisible();
  const button = card.getByRole("button", { name: BUTTON });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(card.getByRole("status")).toHaveText(STARTING);
  pending.release();
  await expect(page).toHaveURL(/\/p\/try-abc0123456$/);
  expect(pending.calls()).toBe(1);
});

test("TY11: on the Overview, a 429 shows the Worker's sentence and the button stays disabled", async ({ page }) => {
  await visitor(page, { ...WITH_TRY, default_view: "overview" });
  const pending = await holdTry(page, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "try_limited", message: LIMITED } }),
    }),
  );
  await page.goto(`/p/${POOL}`);
  const head = page.locator(".overview__head");
  const button = head.getByRole("button", { name: BUTTON });
  await expect(button).toBeVisible();
  await button.click();
  pending.release();
  await expect(head.getByRole("status")).toHaveText(LIMITED);
  await expect(button).toBeDisabled();
});

test("TY11: any other failure shows try.failed and the button can be tapped again", async ({ page }) => {
  await visitor(page);
  let calls = 0;
  await page.route("**/api/try", (route) => {
    calls += 1;
    return route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "try_failed", message: FAILED } }),
    });
  });
  await page.goto(`/p/${POOL}`);
  const button = page.locator(".start-card").getByRole("button", { name: BUTTON });
  await button.click();
  await expect(page.locator(".start-card").getByRole("status")).toHaveText(FAILED);
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => calls).toBe(2);
});

test("TY1 TY11: no button while features.try is off, and none for the owner", async ({ page }) => {
  await visitor(page, { ...FLOOR_JSON, features: { ...FLOOR_JSON.features, try: false } });
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".start-card")).toBeVisible();
  await expect(page.getByRole("button", { name: BUTTON })).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await visitor(page, { ...WITH_TRY, default_view: "overview" }, true);
  await page.goto(`/p/${POOL}`);
  await expect(page.getByRole("button", { name: "Owner", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: BUTTON })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`TY11: the button's tap target is at least 44 by 44 in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await visitor(page, { ...WITH_TRY, default_view: "overview" });
    await page.goto(`/p/${POOL}`);
    const button = page.locator(".overview__head").getByRole("button", { name: BUTTON });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    // The label is readable on its fill: the text and background colors differ.
    const colors = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor };
    });
    expect(colors.color).not.toBe(colors.background);
  });
}
