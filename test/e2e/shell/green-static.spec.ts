// Slice 14 part 14a on the page (04-build-plan 2.15 item 1; 03-floor 3.8, row FR19, banner 8):
// with `features.green` "static", the strip's green cell reads `green.static` once the line
// advanced; a first failed run reads `green.checking` and shows no banner (GR3); a confirmed
// failure reads `green.red` and banner 8 without its second sentence, because part 14a queues
// no revert (GR3b). Expected sentences come from the copy table of 03-floor, not from the page.

import { expect, test } from "@playwright/test";
import { FLOOR_JSON, POOL, ev, poolState, serveStream } from "./stream.ts";

const STATIC_FLOOR = { ...FLOOR_JSON, features: { ...FLOOR_JSON.features, green: "static" } };
const PASS = [
  { name: "parse", ok: true },
  { name: "imports_resolve", ok: true },
  { name: "policy_invariants", ok: true },
];
const FAIL = [
  { name: "parse", ok: true },
  { name: "imports_resolve", ok: true },
  { name: "policy_invariants", ok: false, code: "policy_invariants:failed" },
];
const c1 = "1".repeat(40);
const c2 = "2".repeat(40);

function verified(n: number, seq: number, commit: string, ok: boolean, confirmed: boolean) {
  return ev(n, {
    type: "green.verified",
    seq,
    commit,
    ok,
    runtime: "static",
    checks: ok ? PASS : FAIL,
    ms: 4,
    confirmed,
  });
}

const advancedFrames = [
  poolState(1),
  verified(2, 1, c1, true, true),
  ev(3, { type: "green.advanced", seq: 1, commit: c1 }),
];

const greenCell = '.strip-cell[data-cell="strip.green"]';

test("2.15 item 1: after green.advanced the strip says static checks only", async ({ page }) => {
  await serveStream(page, advancedFrames, [], STATIC_FLOOR);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(greenCell)).toContainText("Green line");
  await expect(page.locator(greenCell)).toContainText("landing 1 · static checks only");
});

test("GR3: a first failed run reads checking again, and no banner says anything is taken back", async ({ page }) => {
  await serveStream(page, [...advancedFrames, verified(4, 2, c2, false, false)], [], STATIC_FLOOR);
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(greenCell)).toContainText("checking landing 2 again");
  await expect(page.locator(".banner", { hasText: "GREEN LINE" })).toHaveCount(0);
  await expect(page.getByText("taking back")).toHaveCount(0);
});

test("GR3b: a confirmed failure reads failed, with banner 8's first sentence only", async ({ page }) => {
  await serveStream(
    page,
    [...advancedFrames, verified(4, 2, c2, false, false), verified(5, 2, c2, false, true)],
    [],
    STATIC_FLOOR,
  );
  await page.goto(`/p/${POOL}`);
  await expect(page.locator(greenCell)).toContainText("failed at landing 2");
  const banner = page.locator(".banner", { hasText: "GREEN LINE" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("The check failed twice at landing 2: The rules of the policy file hold.");
  await expect(banner).not.toContainText("Trunk is taking back");
});
