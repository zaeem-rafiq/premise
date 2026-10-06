// FR33 (03-floor 7): a throw while a view body renders shows `view.failed` in that view
// alone - the header, the strip and the banners keep working, the error goes to the
// browser console, and the view switched to mounts clean. The fault is injected into the
// loaded page (FR33 names no test hook and the page carries none): the Swarm view calls
// `Number.prototype.toFixed` while rendering its metrics number, so the test replaces the
// built-in with one that throws, then restores it.
//
// The scripted stream carries no `limits` event on purpose: the strip's spend cell would
// call `money()` (5.2, toFixed inside) too, and the strip is not inside a view boundary.

import { expect, test } from "@playwright/test";
import { POOL, attemptOpened, ev, intentCreated, metrics, poolState, serveStream, type Frame } from "./stream.ts";

function swarmState(n: number): Frame {
  return ev(n, {
    src: "swarm",
    type: "swarm.state",
    synthetic: true,
    running: true,
    agents: 7,
    collision_dial: 0.3,
    pools: ["swarm", POOL],
  });
}

test.describe("FR33: a view that throws while it draws fails alone", () => {
  test("a throw in the Swarm view shows view.failed there and nowhere else", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await serveStream(page, [
      poolState(1),
      intentCreated(2),
      attemptOpened(3, "a_1", "i_1", { agent: "synthetic" }),
      swarmState(4),
      metrics(5, { landings_per_second: 0.5 }),
    ]);
    await page.goto(`/p/${POOL}`);
    await expect(page.locator(".rail")).toBeVisible();

    // Inject the fault after the page has loaded: a built-in method the Swarm view calls
    // while it renders is replaced by one that throws.
    await page.evaluate(() => {
      const w = window as unknown as { __toFixed?: typeof Number.prototype.toFixed };
      w.__toFixed = Number.prototype.toFixed;
      Number.prototype.toFixed = () => {
        throw new Error("injected render fault");
      };
    });

    await page.getByRole("button", { name: "Swarm" }).first().click();

    // That view alone shows `view.failed` - the sentence of 5.4.
    const failed = page.locator(".floor-body .view-failed");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("This part of the page stopped because of an error.");
    await expect(failed).toContainText("The rest of the page still works.");
    // The header, the strip and the banners keep working.
    await expect(page.getByRole("button", { name: "Floor" }).first()).toBeVisible();
    await expect(page.locator(".strip")).toBeVisible();
    await expect(page.locator(".banner[data-tone='synthetic']")).toBeVisible();
    // The error went to the browser console.
    expect(consoleErrors.length).toBeGreaterThan(0);

    // Restoring the method and switching back mounts the Floor view working again.
    await page.evaluate(() => {
      const w = window as unknown as { __toFixed?: typeof Number.prototype.toFixed };
      if (w.__toFixed !== undefined) Number.prototype.toFixed = w.__toFixed;
    });
    await page.getByRole("button", { name: "Floor" }).first().click();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".view-failed")).toHaveCount(0);

    // And the Swarm view mounts clean again: the failed boundary did not follow it.
    await page.getByRole("button", { name: "Swarm" }).first().click();
    await expect(page.locator(".swarm-view")).toBeVisible();
    await expect(page.locator(".swarm-numbers")).toContainText("0.50");
  });
});
