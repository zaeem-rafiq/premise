import { expect, test } from "@playwright/test";
import {
  attempts,
  attemptState,
  ev,
  headsup,
  intentCreated,
  poolState,
  serveReview,
  type Frame,
} from "./review-fixtures.ts";

test("D6 / CO8, FL10: an intent event after the create reply clears the wait at once", async ({ page }) => {
  const send = await serveReview(page, [poolState(1)]);
  await page.route("**/api/pools/testpool/intents", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ intent_id: "i_new" }) }),
  );
  await page.goto("/p/testpool");
  const field = page.locator(".intent-field");
  await field.fill("a crab");
  const reply = page.waitForResponse(
    (response) => response.url().endsWith("/intents") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await reply;
  await expect(field).toHaveJSProperty("readOnly", true);
  await expect(field).toHaveValue("a crab");
  send([intentCreated(2, "i_new", "a crab")]);
  await expect(field).toHaveValue("", { timeout: 1000 });
  await expect(field).toHaveJSProperty("readOnly", false);
  await field.fill("another crab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("D10 / CO10, CO13: compact cards keep their tags and a reopened race candidate leaves the group", async ({
  page,
}) => {
  const frames = attempts(6).map((frame) =>
    frame.type === "intent.created"
      ? { ...frame, prewritten: true }
      : frame.type === "attempt.opened" && frame.attempt_id === "a_1"
        ? { ...frame, race: true }
        : frame,
  );
  const send = await serveReview(page, frames);
  await page.goto("/p/testpool");
  const card = page.locator('[data-attempt-id="a_1"]');
  await expect(card.locator(".attempt-card__tag")).toHaveText("Pre-written");
  send([
    ev(20, { type: "attempt.reopened", attempt_id: "a_1", cause: "undo", revision: 2, model_changed: false }),
    attemptState(21, "a_1", "landed", "working"),
  ]);
  await expect(page.locator('.race-group [data-attempt-id="a_1"]')).toHaveCount(0);
  await expect(card).toHaveClass(/attempt-card--compact/);
  await expect(card.getByText("Reopened by undo", { exact: true })).toBeVisible();
  await expect(card.getByText("Same agent, same conversation.", { exact: true })).toBeVisible();
});

test("D34 / FL5: selecting a pre-written request exposes its text, keeping the id internal", async ({ page }) => {
  await serveReview(page, [poolState(1)], {
    prewritten: [{ id: "A01", text: "a fish", group: "starter", race: false }],
  });
  await page.goto("/p/testpool");
  const menu = page.getByRole("combobox", { name: "Pre-written requests" });
  await expect(menu.locator('option[value="A01"]')).toHaveText("a fish");
  await menu.selectOption("A01");
  await expect(page.locator(".intent-field")).toHaveValue("a fish");
});

test("D35 / 3.4, CO19: query source is a marked code block and Show all expands beyond twelve lines", async ({
  page,
}) => {
  const panel = headsup(5);
  const item = (panel.items as Frame[])[0]!;
  item.premise = { kind: "query", key: "text:creatures/:drain(" };
  item.rule = "QT1";
  item.diff = {
    kind: "query",
    added: [
      { key: "creatures/squid.js#update", source: Array.from({ length: 13 }, (_, i) => `line${i + 1}();`).join("\n") },
    ],
    removed: [],
    context: [],
  };
  await serveReview(page, [...attempts(1), panel]);
  await page.goto("/p/testpool");
  const block = page.locator(".headsup-code__text");
  await expect(block).toContainText("line12();");
  await expect(block).not.toContainText("line13();");
  await expect(block.locator("mark")).toHaveCSS("text-decoration-line", "underline");
  await page.getByRole("button", { name: "Show all 13 lines" }).click();
  await expect(block).toContainText("line13();");
});
