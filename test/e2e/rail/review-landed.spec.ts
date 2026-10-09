import { expect, test } from "@playwright/test";
import { ev, poolState, serveReview, intentCreated, attemptOpened, attemptState } from "./review-fixtures.ts";

test("D15 / FL3, 3.8, 3.19: strip and Landed tab count confirmed changes and keep undo rows", async ({ page }) => {
  const accept = (n: number, seq: number, kind: string) =>
    ev(n, {
      type: "landing.accepted",
      seq,
      batch_id: seq,
      kind,
      attempt_id: null,
      change_id: `c${seq}`,
      intent_id: null,
      request_id: null,
      paths: [],
      writes: [],
    });
  const land = (n: number, seq: number) =>
    ev(n, {
      type: "landing.landed",
      seq,
      batch_id: seq,
      commit: `c${seq}`,
      tree: "tree",
      note: "note",
      note_json: "{}",
      time_to_land_ms: 1,
    });
  const send = await serveReview(page, [poolState(1), accept(2, 1, "change")]);
  await page.goto("/p/testpool");
  const tab = page.getByRole("tab", { name: /^Landed/ });
  const counter = page.locator('[data-cell="strip.landed"] .strip-value');
  await expect(tab).toHaveText("Landed 0");
  await expect(counter).toHaveText("0");
  send([land(3, 1), accept(4, 2, "undo"), land(5, 2), accept(6, 3, "change")]);
  await expect(tab).toHaveText("Landed 1");
  await expect(counter).toHaveText("1");
  await tab.click();
  await expect(page.locator('.landed-row[data-kind="undo"]')).toHaveCount(1);
  await expect(page.locator(".landed-pending")).toHaveText(/Landing…/);
});

test("D37 / CO12, FL9: old landed cards stay out of Working on mount and on return from Compare", async ({ page }) => {
  await serveReview(page, [
    poolState(1, { plain_remote: "https://artifacts.invalid/plain" }),
    intentCreated(2),
    attemptOpened(3),
    ev(4, {
      type: "landing.accepted",
      seq: 1,
      batch_id: 1,
      kind: "change",
      attempt_id: "a_1",
      change_id: "c_a_1",
      intent_id: "i_1",
      request_id: null,
      paths: [],
      writes: [],
    }),
    ev(5, {
      type: "landing.landed",
      seq: 1,
      batch_id: 1,
      commit: "c1",
      tree: "t",
      note: "n",
      note_json: "{}",
      time_to_land_ms: 1,
    }),
    attemptState(6, "a_1", "accepted", "landed"),
    poolState(7, { ts: 10_000, landed_seq: 1, landed_commit: "c1", plain_remote: "https://artifacts.invalid/plain" }),
  ]);
  await page.goto("/p/testpool");
  await expect(page.getByRole("tab", { name: "Landed 1", exact: true })).toBeVisible();
  expect(await page.locator('.rail-list [data-attempt-id="a_1"]').count()).toBe(0);
  await page.getByRole("button", { name: "Compare", exact: true }).first().click();
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Landed 1", exact: true })).toBeVisible();
  expect(await page.locator('.rail-list [data-attempt-id="a_1"]').count()).toBe(0);
});
