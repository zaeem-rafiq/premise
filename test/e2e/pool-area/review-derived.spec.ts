import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { serveSession, serveStream } from "../shell/stream.ts";

test("D34 FL5: the derived check reads in plain words where checks are listed, and no code word reaches the held sheet", async ({
  page,
}) => {
  const events = readFileSync("public/replay/hero-canned.ndjson", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => typeof event.type === "string");
  // The recording's first held submit carries the actual derived check of CK7.
  const held = events.findIndex(
    (event) =>
      event.type === "submit.result" &&
      event.status === "held" &&
      Array.isArray(event.checks) &&
      event.checks.some((check: { name?: string }) => check.name === "derived"),
  );
  expect(held).toBeGreaterThan(0);
  await serveSession(page, false);
  await serveStream(page, events.slice(0, held + 1));
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool frame stub</title>" }),
  );
  await page.goto("/");
  // The expanded attempt card lists every check (5.7): the derived one in plain words (FL5).
  const card = page.locator(`.rail [data-attempt-id="${String(events[held]!.attempt_id)}"]`).first();
  await card.locator(".attempt-card__intent").click(); // expand (03 3.2)
  await expect(card.getByText("What the change uses and affects is recorded", { exact: false })).toBeVisible();
  // The held sheet gives the count line of 2.4 and lists only a failed check; no code word either way.
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  const sheet = page.locator(".card-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/of \d+ checks? passed\./)).toBeVisible();
  await expect(sheet.getByText("derived", { exact: true })).toHaveCount(0);
});
