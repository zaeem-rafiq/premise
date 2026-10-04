// Track 1F acceptance: `/replay/tracer` plays the fixture stream under the REPLAY banner with no
// Worker running. The built Floor is static (`vite preview` of dist/client), so the recording's
// static routes are fulfilled here with the fixture itself (`test/fixtures/streams/tracer.ndjson`,
// the file the plan names for this track). Expected values are the fixture header and the
// sentences of 03-floor 5.3–5.8, never this page's output (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURE = join(import.meta.dirname, "../../fixtures/streams/tracer.ndjson");
const NDJSON = readFileSync(FIXTURE, "utf8");
const HEADER = JSON.parse(NDJSON.split("\n", 1)[0] ?? "{}") as { events: number; label: string };

const INDEX_JSON = {
  v: 1,
  default: "tracer",
  recordings: [
    {
      id: "tracer",
      file: "/replay/tracer.ndjson",
      title: "tracer",
      duration_ms: 10_000,
      events: HEADER.events,
      bytes: NDJSON.length,
      synthetic: false,
      recorded_at: "2024-01-01T00:01:00.000Z",
    },
  ],
};

/** Serves the recording's static routes with the fixture (Replay's only fetches, RY1). */
async function serveRecording(page: Page): Promise<void> {
  await page.route("**/replay/index.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(INDEX_JSON) }),
  );
  await page.route("**/replay/tracer.ndjson", (route) =>
    route.fulfill({ contentType: "application/x-ndjson", body: NDJSON }),
  );
}

test.describe("/replay/tracer (Track 1F)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Track 1F: /replay/tracer plays the fixture under the REPLAY banner with no Worker running", async ({
    page,
  }) => {
    await serveRecording(page);
    await page.goto("/replay/tracer");
    // RY3: the REPLAY banner is on screen from the moment the recording starts loading.
    await expect(page.getByText("REPLAY", { exact: true }).first()).toBeVisible();
    // The recording plays: the tracer intent becomes an attempt card.
    await expect(page.locator(".attempt-card").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("draw tracer fish").first()).toBeVisible();
  });

  test("AC3: Landing… shows while landing.landed has not arrived, then Landed (FL3)", async ({ page }) => {
    await serveRecording(page);
    await page.goto("/replay/tracer");
    const card = page.locator('.attempt-card[data-attempt-id="a_T"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // The landing.accepted window (recorded ts 1704067204100 → 1704067206500) reads "Landing…".
    await expect(card.getByText("Landing…")).toBeVisible({ timeout: 30_000 });
    // …and "Landed" only once landing.landed has arrived.
    await expect(card.getByText("Landed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("On main as landing 1.")).toBeVisible();
  });

  test("RY19: after the last event the bar reads replay.ended and the page stays on the final state", async ({
    page,
  }) => {
    await serveRecording(page);
    await page.goto("/replay/tracer");
    await expect(page.getByText("The recording has ended.")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("REPLAY", { exact: true }).first()).toBeVisible();
  });
});
