// The lead's live check (04-build-plan 2.2, acceptance 4): a scripted agent lands on a real
// deployment and the page shows the whole arc — SYNTHETIC banner, the card's "Landing…" then
// "Landed", the Landed counter moving — while the live frame stays on its `main` address and
// the page never reloads. Runs only under `--project=deployed`; the fixture project skips it.
// The owner key goes as a Bearer header on the request the test process makes (SWR1, SE2):
// it is never typed into the page and never printed.

import { expect, test } from "@playwright/test";

const POOL = process.env.PREMISE_POOL ?? "it-tracer";

test("a scripted agent lands and the page shows it, with no reload", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "deployed", "runs against a deployment only");
  const ownerKey = process.env.PREMISE_OWNER_KEY;
  test.skip(ownerKey === undefined || ownerKey === "", "PREMISE_OWNER_KEY is not set");
  test.setTimeout(300_000);

  await page.goto(`/p/${POOL}`);
  await expect(page.locator(".pool-name")).toHaveText(POOL);

  // This marker survives only while the document is not reloaded.
  await page.evaluate(() => ((window as { __tracer?: boolean }).__tracer = true));

  const landedCell = page.locator(".strip-cell", { hasText: "Landed" }).first();
  await expect(landedCell.locator(".strip-value")).toBeVisible();
  const landedBefore = Number(await landedCell.locator(".strip-value").innerText());

  const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
  await expect(iframe).toHaveAttribute("src", new RegExp(`/pool/${POOL}/main/`), { timeout: 60_000 });
  const frameSrc = (await iframe.getAttribute("src"))!;

  const response = await request.post("/api/swarm", {
    headers: { Authorization: `Bearer ${ownerKey}` },
    data: {
      pool: POOL,
      running: true,
      patterns: ["add-plain"],
      request_id: `tracer-${Date.now()}`,
    },
  });
  expect(response.ok(), `POST /api/swarm answered ${response.status()}`).toBe(true);

  // Opening the first scripted attempt sets pool.synthetic (EM1a) → the SYNTHETIC banner.
  await expect(page.locator(".banner[data-tone='synthetic']")).toBeVisible({ timeout: 120_000 });

  // FL3: the card reads "Landing…" while landing.landed has not arrived, then "Landed".
  await expect(page.locator(".attempt-card", { hasText: "Landing…" }).first()).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.locator(".attempt-card", { hasText: "Landed" }).first()).toBeVisible({
    timeout: 180_000,
  });
  await expect.poll(async () => Number(await landedCell.locator(".strip-value").innerText())).toBe(landedBefore + 1);

  // SE16a: a live frame moves by probe — the address stays on `main` and nothing reloaded.
  await expect(iframe).toHaveAttribute("src", frameSrc);
  await expect.poll(async () => page.evaluate(() => (window as { __tracer?: boolean }).__tracer === true)).toBe(true);
});
