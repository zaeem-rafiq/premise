// LY5 for the Why card's "What it relied on" lights, on the assembled Floor with hero-c04 through
// the live stream. CO15 gives a light in a list its drawn size, 16 across; LY5 makes every tap
// target at least 44x44. The pool host is stubbed as in lead/look.spec.ts.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { POOL, serveSession, serveStream } from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

const FRAMES = readFileSync(new URL("../../fixtures/streams/hero-c04.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => ({ ...(JSON.parse(line) as Frame), pool: POOL }));

for (const size of [
  { name: "stage", width: 1920, height: 1080 },
  { name: "laptop", width: 1440, height: 900 },
] as const) {
  test(`LY5, CO15: the Why card's relied-on lights draw 16 across in 44x44 targets (${size.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await serveStream(page, FRAMES);
    await serveSession(page, false);
    await page.route("**/pool/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>pool</title>" }),
    );
    await page.goto(`/p/${POOL}`);
    await page.getByRole("tab", { name: /Landed/ }).click();
    await page.locator(".landed-row", { hasText: "crab" }).first().click();
    const relied = page.locator('.why-sheet .why-section[data-section="relied"]');
    await expect(relied).toBeVisible();
    const lights = relied.locator(".light");
    // hero-c04's crab relied on ENERGY_MAX and on its own file (3.9's WHAT IT RELIED ON).
    await expect(lights).toHaveCount(2);
    const boxes = await lights.evaluateAll((elements) =>
      elements.map((light) => {
        const target = light.getBoundingClientRect();
        const drawn = light.querySelector("svg")!.getBoundingClientRect();
        return {
          name: light.getAttribute("aria-label"),
          focusable: light.getAttribute("tabindex") === "0",
          target: { top: target.top, bottom: target.bottom, width: target.width, height: target.height },
          drawn: { width: drawn.width, height: drawn.height },
        };
      }),
    );
    for (const light of boxes) {
      expect(light.focusable, `${light.name}: a focus stop`).toBe(true);
      expect(light.drawn, `${light.name}: drawn size`).toEqual({ width: 16, height: 16 });
      expect(light.target.width, `${light.name}: target width`).toBeGreaterThanOrEqual(44);
      expect(light.target.height, `${light.name}: target height`).toBeGreaterThanOrEqual(44);
    }
    // Neighbouring rows keep their targets apart.
    expect(boxes[1]!.target.top).toBeGreaterThanOrEqual(boxes[0]!.target.bottom);
  });
}
