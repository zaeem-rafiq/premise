// D27: rendered count copy on fixture streams. Expectations follow CP5 and 5.2.
import { expect, test } from "@playwright/test";
import { ev, poolState, serveSession, serveStream } from "../shell/stream.ts";

for (const agents of [1, 1024]) {
  test(`D27 CP5/5.2: Swarm renders ${agents === 1 ? "one agent" : "comma-separated counts"}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await serveSession(page, false);
    await page.route("**/pool/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool frame stub</title>" }),
    );
    await serveStream(page, [
      poolState(1, { app: "tidepool", synthetic: true }),
      ev(2, {
        type: "swarm.state",
        running: true,
        synthetic: true,
        agents,
        collision_dial: 0,
        pools: ["swarm"],
      }),
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "Swarm", exact: true }).click();
    const banner = page.locator(".banner[data-tone='synthetic']");
    await expect(banner).toContainText(
      agents === 1 ? "1 scripted agent · it makes no model calls" : "1,024 scripted agents · they make no model calls",
    );
    await expect(page.locator(".swarm-shape")).toContainText(
      agents === 1 ? "1 scripted agent." : "1,024 scripted agents.",
    );
  });
}
