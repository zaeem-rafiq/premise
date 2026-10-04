// The owner-key entry of 03-floor 3.17 and the kill switch of 3.18: AC16/CO45 (the key
// appears in no address, no browser storage, no console line and no request other than
// POST /api/session), AC5/FL7 (a visitor's document holds no owner control at all, Replay
// holds none), AC17/CO2 (two fast taps on "Stop all agents" send one request), FR21 (a
// 401 ends the session: toast owner.expired, header owner.visitor, the dialog opens) and
// FR22 (a failed request shows the 5.9 sentence next to the control and as a toast, the
// control is enabled again).

import { expect, test } from "@playwright/test";
import {
  POOL,
  attemptOpened,
  intentCreated,
  limits,
  poolState,
  serveSession,
  serveStream,
} from "./stream.ts";

const OWNER_KEY = "owner-key-test-only";

const FRAMES = [poolState(1), intentCreated(2), attemptOpened(3)];

test.describe("AC16 / CO45: the key stays inside POST /api/session", () => {
  test("pasting the key leaks it nowhere else", async ({ page }) => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const consoleLines: string[] = [];
    const postedKeys: (string | undefined)[] = [];
    page.on("request", (request) => {
      urls.push(request.url());
      const data = request.postData();
      if (data !== null) bodies.push(data);
    });
    page.on("console", (message) => consoleLines.push(message.text()));

    await serveStream(page, FRAMES);
    await serveSession(page, false, (key) => postedKeys.push(key));
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".strip")).toBeVisible();

    // Open the owner dialog, paste the key once, unlock.
    await page.getByRole("button", { name: "Visitor" }).click();
    const dialog = page.locator(".owner-sheet");
    await expect(dialog).toBeVisible();
    const field = dialog.locator('input[type="password"]');
    await expect(field).toHaveAttribute("autocomplete", "current-password");
    await field.fill(OWNER_KEY);
    await dialog.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Owner", exact: true })).toBeVisible();

    // The only request that carries the key is POST /api/session.
    expect(postedKeys).toEqual([OWNER_KEY]);
    const leaks = bodies.filter((body) => body.includes(OWNER_KEY));
    expect(leaks.length).toBe(1);
    for (const url of urls) expect(url, `key in the address ${url}`).not.toContain(OWNER_KEY);
    expect(page.url()).not.toContain(OWNER_KEY);

    // Not in storage, not in the console.
    const stored = await page.evaluate(
      () =>
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
          cookies: document.cookie,
        }),
    );
    expect(stored).not.toContain(OWNER_KEY);
    for (const line of consoleLines) expect(line, `console: ${line}`).not.toContain(OWNER_KEY);
  });
});

test.describe("AC5 / FL7: visitors and Replay hold no owner control", () => {
  test("a visitor's document has no owner control at all", async ({ page }) => {
    await serveStream(page, [...FRAMES, limits(4, { spend: 1, cap: 40, killed: true })]);
    await page.goto(`/p/${POOL}`);
    // No kill switch, no allow button, no owner sheet content.
    await expect(page.getByRole("button", { name: "Stop all agents" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Allow agents again" })).toHaveCount(0);
    await expect(page.locator(".owner-sheet")).toHaveCount(0);
    // The header button reads the visitor form and opens the dialog only.
    await page.getByRole("button", { name: "Visitor" }).click();
    await expect(page.locator(".owner-sheet")).toBeVisible();
    // Inside it there is no Lock (the session is not the owner's).
    await expect(page.getByRole("button", { name: "Lock" })).toHaveCount(0);
  });

  test("Replay holds no owner control (CO46)", async ({ page }) => {
    await page.goto("/replay/tracer");
    await expect(page.locator(".replay-bar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop all agents" })).toHaveCount(0);
    const owner = page.getByRole("button", { name: "Replay" });
    await expect(owner).toBeVisible();
    await expect(owner).toBeDisabled();
    // Swarm inside Replay: no owner controls either (FL7).
    await page.keyboard.press("s");
    await expect(page.locator(".swarm-controls")).toHaveCount(0);
    await page.keyboard.press("f");
  });
});

test.describe("the kill switch (3.18, AC17/CO2, CO47, FR21, FR22)", () => {
  test("AC17/CO2: two fast taps on 'Stop all agents' send one request", async ({ page }) => {
    const kills: string[] = [];
    await serveStream(page, FRAMES);
    await serveSession(page, true);
    await page.route("**/api/kill", async (route) => {
      kills.push(route.request().postData() ?? "");
      // Hold the answer a beat so the second tap lands inside the in-flight window.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 200, body: "{}" });
    });
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "Stop all agents" }).click();
    const dialog = page.locator(".kill-sheet");
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Stop all agents" });
    // Two fast taps.
    await confirm.click();
    await confirm.click({ force: true });
    await expect(dialog).toHaveCount(0);
    expect(kills, `one POST /api/kill, got ${kills.length}`).toHaveLength(1);
    expect(kills[0]).toContain('"killed":true');
  });

  test("CO47: key K opens the dialog and Enter confirms", async ({ page }) => {
    const kills: string[] = [];
    await serveStream(page, FRAMES);
    await serveSession(page, true);
    await page.route("**/api/kill", async (route) => {
      kills.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, body: "{}" });
    });
    await page.goto(`/p/${POOL}`);
    await page.keyboard.press("k");
    const dialog = page.locator(".kill-sheet");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => kills.length).toBe(1);
  });

  test("FR21: a 401 ends the session - toast, visitor header, the dialog opens", async ({ page }) => {
    await serveStream(page, FRAMES);
    await serveSession(page, true);
    await page.route("**/api/kill", (route) => route.fulfill({ status: 401, body: "{}" }));
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "Stop all agents" }).click();
    await page.locator(".kill-sheet").getByRole("button", { name: "Stop all agents" }).click();
    // owner.expired as a toast, the header back to Visitor, the key dialog open.
    await expect(page.locator(".toast")).toContainText("Your owner session has ended. Enter the key again.");
    await expect(page.locator(".owner-sheet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Visitor" })).toBeVisible();
  });

  test("FR22: a failed request shows the 5.9 sentence and the control is enabled again", async ({
    page,
  }) => {
    await serveStream(page, FRAMES);
    await serveSession(page, true);
    await page.route("**/api/kill", (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.goto(`/p/${POOL}`);
    await page.getByRole("button", { name: "Stop all agents" }).click();
    const dialog = page.locator(".kill-sheet");
    await dialog.getByRole("button", { name: "Stop all agents" }).click();
    // The sentence next to the control and as a toast; the dialog stays open (3.18 error).
    await expect(dialog.locator(".field-error")).toContainText("Something went wrong (status 500)");
    await expect(page.locator(".toast")).toContainText("Something went wrong (status 500)");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stop all agents" })).toBeEnabled();
  });

  test("a killed pool turns the header button into kill.allow (3.18 stopped row)", async ({ page }) => {
    await serveStream(page, [...FRAMES, limits(4, { spend: 1, cap: 40, killed: true })]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await expect(page.getByRole("button", { name: "Allow agents again" })).toHaveCount(2); // header + banner
  });
});
