// The banner stack of 03-floor 3.18/5.11 and the failure rows whose surface is the stack
// or the strip: AC4/CO49 (SYNTHETIC with no close control in every view and sheet), the
// fixed order, FR11's paused pool with its Rebuild button for the owner, the killed
// banner (FR9) with kill.allow, the spend-cap banner (FR8), the push banner (FR6) and
// banner.more (CO50), and FR10's offline banner.

import { expect, test } from "@playwright/test";
import {
  FLOOR_JSON,
  POOL,
  attemptOpened,
  cardOpened,
  choiceCard,
  ev,
  intentCreated,
  limits,
  metrics,
  poolPaused,
  poolState,
  serveSession,
  serveStream,
} from "./stream.ts";

test.describe("AC4 / CO49 / FL4: the SYNTHETIC banner has no close control, everywhere", () => {
  const syntheticFrames = [
    poolState(1, { synthetic: true }),
    intentCreated(2),
    attemptOpened(3, "a_1", "i_1", { agent: "synthetic", model: null }),
  ];

  test("Floor view, an open sheet and the Swarm view", async ({ page }) => {
    await serveStream(page, syntheticFrames);
    await page.goto(`/p/${POOL}`);

    const banner = page.locator(".banner[data-tone='synthetic']");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("SYNTHETIC");
    // One scripted attempt in the stream: the n = 1 form of banner.synthetic (CP5).
    await expect(banner).toContainText("1 scripted agent · it makes no model calls");
    // No close control - and no button at all on banner 1 (CO49).
    await expect(banner.locator("button")).toHaveCount(0);

    // An open sheet: the banner is still on, still without a close (FL4).
    await page.getByRole("button", { name: "About" }).click();
    await expect(page.locator(".sheet")).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(banner.locator("button")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Swarm view: the banner reads the Swarm form (banner.synthetic.swarm).
    await page.getByRole("button", { name: "Swarm" }).first().click();
    await expect(banner).toContainText("shared rules land without a tap");
    await expect(banner.locator("button")).toHaveCount(0);
  });

  test("Replay draws both banners and neither closes", async ({ page }) => {
    // A synthetic recording: banner 1 and banner 2 together, neither with a control.
    const recording = [
      JSON.stringify({
        premise_replay: 2,
        pool: POOL,
        recorded_at: "2024-01-02T00:00:00.000Z",
        events: 2,
        synthetic: true,
        build: "fixtures/1",
        label: "synth run",
      }),
      JSON.stringify(poolState(1, { synthetic: true })),
      JSON.stringify(intentCreated(2)),
    ].join("\n");
    await page.route("**/replay/synth.ndjson", (route) =>
      route.fulfill({ contentType: "application/x-ndjson", body: recording }),
    );
    await page.goto("/replay/synth");
    const synthetic = page.locator(".banner[data-tone='synthetic']");
    const replay = page.locator(".banner[data-tone='replay']");
    await expect(synthetic).toBeVisible();
    await expect(replay).toBeVisible();
    await expect(synthetic.locator("button")).toHaveCount(0);
    await expect(replay.locator("button")).toHaveCount(0);
  });
});

test.describe("the fixed order and count (3.18, CO50)", () => {
  test("banners draw in the table's order; past three they count in banner.more", async ({ page }) => {
    // Killed (3) + paused-by-owner (4) + cap (6) + push pending (7): banner 3 reads
    // `banner.killed.landings` when the owner pause is on (3.18 table note), then 4, 6, 7.
    await serveStream(page, [
      poolState(1),
      intentCreated(2),
      attemptOpened(3),
      poolPaused(4, "owner"),
      limits(5, { spend: 50, cap: 40, killed: true, refusing: true }),
      // 4.4 pushStalled: the banner waits until the push is older than PUSH_STALL_MS (5 s)
      // on the stream clock - the retry carries an old ts, the last event a new one.
      ev(6, { type: "push.retry", batch_id: 1, tries: 2, error: "timeout", next_try_ms: 1000, ts: 2_000, t: 2_000 }),
      metrics(7, { waiting_behind: 2, push_backlog: 3, ts: 8_000, t: 8_000 }),
    ]);
    await page.goto(`/p/${POOL}`);

    const words = page.locator(".banners > .banner:not(.banner-more) .banner-word");
    await expect(words).toHaveCount(3);
    // Order of 3.18: killed (with landings) first, then paused, then cap.
    await expect(words.nth(0)).toHaveText("AGENTS STOPPED");
    await expect(words.nth(1)).toHaveText("POOL PAUSED");
    await expect(words.nth(2)).toHaveText("SPEND CAP");
    await expect(page.locator(".banners")).toContainText("The kill switch is on and landings are paused.");
    // The fourth (PUSH PENDING) sits behind banner.more (CO50).
    const more = page.locator(".banner-more-button");
    await expect(more).toHaveText("1 more notices");
    await more.click();
    await expect(page.locator(".banner-more-list")).toContainText("PUSH PENDING");
    await expect(page.locator(".banner-more-list")).toContainText("has not been confirmed yet");
  });
});

test.describe("FR11 / LP8: a paused pool offers Rebuild to the owner only", () => {
  const frames = [
    poolState(1),
    intentCreated(2),
    attemptOpened(3),
    ev(4, { type: "push.retry", batch_id: 1, tries: 3, error: "push_rejected", next_try_ms: 1000 }),
    poolPaused(5, "push_rejected"),
  ];

  test("visitor: the banner with no button", async ({ page }) => {
    await serveStream(page, frames);
    await page.goto(`/p/${POOL}`);
    const banner = page.locator(".banner[data-tone='changed']").first();
    await expect(banner).toContainText("Artifacts refused the same push");
    await expect(banner).toContainText("Nothing lands until the pool is rebuilt.");
    await expect(banner.getByRole("button", { name: "Rebuild from Artifacts" })).toHaveCount(0);
  });

  test("owner: Rebuild opens the confirm dialog and posts once", async ({ page }) => {
    const posts: string[] = [];
    await serveStream(page, frames);
    await serveSession(page, true);
    await page.route("**/api/pools/*/rebuild", async (route) => {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, body: "{}" });
    });
    await page.goto(`/p/${POOL}`);
    const button = page.getByRole("button", { name: "Rebuild from Artifacts" });
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.locator(".rebuild-sheet");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Rebuild the pool from Artifacts?");
    await dialog.getByRole("button", { name: "Rebuild" }).click();
    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(1);
  });
});

test.describe("FR9: the killed banner and allow", () => {
  const frames = [poolState(1), intentCreated(2), attemptOpened(3), limits(4, { spend: 1, cap: 40, killed: true })];

  test("visitor sees the banner and no owner control", async ({ page }) => {
    await serveStream(page, frames);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".banner[data-tone='changed']")).toContainText(
      "The kill switch is on. No model call starts. Checked changes still land.",
    );
    await expect(page.getByRole("button", { name: "Allow agents again" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop all agents" })).toHaveCount(0);
  });

  test("owner sees kill.allow; the banner leaves only when limits.killed ends (CO48)", async ({ page }) => {
    const kills: string[] = [];
    await serveStream(page, frames);
    await serveSession(page, true);
    await page.route("**/api/kill", async (route) => {
      kills.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, body: "{}" });
    });
    await page.goto(`/p/${POOL}`);
    const allow = page.getByRole("button", { name: "Allow agents again" }).first();
    await expect(allow).toBeVisible();
    await allow.click();
    // The request succeeded but the banner stays until the stream says so (CO48).
    expect(kills).toHaveLength(1);
    expect(kills[0]).toContain('"killed":false');
    await expect(page.locator(".banner[data-tone='changed']")).toContainText("The kill switch is on");
  });
});

test.describe("the strip (3.8, 3.18)", () => {
  test("run clock, counters, backlog sub-line and the spend bar", async ({ page }) => {
    await serveStream(page, [
      poolState(1),
      intentCreated(2),
      attemptOpened(3),
      metrics(4, { waiting_behind: 2, push_backlog: 3 }),
      limits(5, {
        spend: 10,
        cap: 40,
        models: [{ model: "model-a", per_minute: 60, used_last_minute: 12 }],
      }),
    ]);
    await page.goto(`/p/${POOL}`);
    const strip = page.locator(".strip");
    await expect(strip.getByText("Real agents")).toBeVisible();
    await expect(strip).toContainText("4 of 6");
    await expect(strip).toContainText("Limit set by the model rate.");
    await expect(strip).toContainText("Landed");
    await expect(strip).toContainText("Go-arounds");
    // metrics.waiting_behind 2 + push_backlog 3 -> the backlog sub-line (3.8).
    await expect(strip).toContainText("2");
    await expect(strip).toContainText("3 waiting for a push");
    // Spend: "$10.00 of $40.00" and the bar at 25% (3.18).
    const spend = page.locator(".strip-cell", { hasText: "Spend" });
    await expect(spend).toContainText("$10.00 of $40.00");
    const width = await spend.locator(".strip-bar-fill").evaluate((el) => (el as HTMLElement).style.width);
    expect(width).toBe("25%");
    const [fillBox, barBox] = await Promise.all([
      spend.locator(".strip-bar-fill").boundingBox(),
      spend.locator(".strip-bar").boundingBox(),
    ]);
    expect(fillBox!.width / barBox!.width).toBeCloseTo(0.25, 1);
    // Hover lists the model's use (spend.model_line).
    await spend.hover();
    await expect(spend.locator(".strip-tip")).toContainText("model-a: 12 of 60 requests in the last minute.");
  });

  test("empty cells read the dash (3.8 loading/empty)", async ({ page }) => {
    // No event applied yet: every counter cell reads the dash of `strip.dash`.
    await serveStream(page, []);
    await page.goto(`/p/${POOL}`);
    for (const label of ["Run clock", "Real agents", "Landed", "Go-arounds"]) {
      await expect(page.locator(".strip-cell", { hasText: label })).toContainText("–");
    }
    await expect(page.locator(".strip-cell", { hasText: "Waiting" })).toContainText("–");
  });

  test("FR7: near the cap the spend cell reads in the confirm tone", async ({ page }) => {
    await serveStream(page, [poolState(1), intentCreated(2), limits(3, { spend: 33, cap: 40 })]);
    await page.goto(`/p/${POOL}`);
    const spend = page.locator(".strip-cell[data-tone='confirm']", { hasText: "Spend" });
    await expect(spend).toContainText("Spend is near the cap.");
    await expect(page.locator(".banner")).toHaveCount(0); // no cap banner yet
  });
});
