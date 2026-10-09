import { expect, test } from "@playwright/test";
import {
  FLOOR_JSON,
  POOL,
  attemptOpened,
  ev,
  intentCreated,
  metrics,
  poolState,
  serveSession,
  serveStream,
  type Frame,
} from "./stream.ts";

async function separateStreams(page: import("@playwright/test").Page, swarm: Frame[]) {
  await serveStream(page, [poolState(1), metrics(2, { landings_per_second: 99 })]);
  await page.routeWebSocket(/\/api\/pools\/swarm\/stream/, (ws) => {
    ws.onMessage(() =>
      ws.send(JSON.stringify({ events: swarm.map((event) => ({ ...event, pool: FLOOR_JSON.swarm_pool })) })),
    );
  });
}
const running = (n: number, agents = 64) =>
  ev(n, {
    type: "swarm.state",
    src: "swarm",
    synthetic: true,
    running: true,
    agents,
    collision_dial: 0.4,
    pools: ["swarm"],
  });

test("D7 CO42 CO44a: Swarm reads its own pool and returns to the main pool", async ({ page }) => {
  await separateStreams(page, [
    poolState(1, { synthetic: true }),
    running(2),
    intentCreated(3),
    attemptOpened(4, "scripted", "i_1", { agent: "synthetic" }),
    metrics(5, { landings_per_second: 4.25 }),
  ]);
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "Swarm", exact: true }).click();
  await expect(page.locator(".swarm-numbers")).toContainText("4.25");
  await expect(page.locator(".banner[data-tone=synthetic]")).toContainText("64 scripted agents");
  await expect(page.locator(".swarm-numbers")).not.toContainText("99.00");
  await expect(page.locator(".swarm-view")).not.toContainText("Starting 64");
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await expect(page.locator(".swarm-view")).toHaveCount(0);
});

test("D7 FR24 FL10: Starting ends after 10 seconds without a scripted attempt", async ({ page }) => {
  await page.clock.install();
  await separateStreams(page, [poolState(1, { synthetic: true }), running(2)]);
  await serveSession(page, true);
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "Swarm", exact: true }).click();
  await expect(page.locator(".swarm-view")).toContainText("Starting 64 scripted agents…");
  await page.clock.runFor(9_000);
  await expect(page.locator(".swarm-view")).not.toContainText("Stop it and start again");
  await page.clock.runFor(2_000);
  await expect(page.locator(".swarm-view")).toContainText("Stop it and start again");
  await expect(page.locator(".swarm-view")).not.toContainText("Starting 64 scripted agents…");
});

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  for (const theme of ["dark", "light"]) {
    test(`D8 CO41 VD2 FL5: one canvas fits 1,024 agents at ${size.width} ${theme}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.addInitScript((theme) => localStorage.setItem("premise.theme", theme), theme);
      const frames = [poolState(1, { synthetic: true }), running(2, 1024)];
      for (let i = 0; i < 1024; i += 1) {
        frames.push(
          intentCreated(3 + i * 2, `i_${i}`),
          attemptOpened(4 + i * 2, `a_${i}`, `i_${i}`, { agent: "synthetic" }),
        );
      }
      await separateStreams(page, frames);
      await page.goto(`/p/${POOL}`);
      await page.getByRole("button", { name: "Swarm", exact: true }).click();
      const wall = page.locator("canvas.swarm-wall");
      await expect(wall).toHaveCount(1);
      await expect(wall).toHaveAccessibleName(/1,024 scripted agents/);
      await expect(page.locator(".swarm-tile")).toHaveCount(0);
      const dimensions = await page.locator(".floor-swarm").evaluate((node) => ({
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        height: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
      await page.screenshot({ path: `.tmp-test/review-swarm-${size.width}-${theme}.png` });
    });
  }
}

test("D18 FL10 3.15: Start keeps waiting after the reply until swarm.state arrives", async ({ page }) => {
  await serveStream(page, [poolState(1)]);
  await serveSession(page, true);
  let send: ((data: string) => void) | undefined;
  await page.routeWebSocket(/\/api\/pools\/swarm\/stream/, (ws) => {
    send = (data) => ws.send(data);
    ws.onMessage(() => ws.send(JSON.stringify({ events: [poolState(1)] })));
  });
  let answered = false;
  await page.route("**/api/swarm", async (route) => {
    await route.fulfill({ json: { ok: true } });
    answered = true;
  });
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "Swarm", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => answered).toBe(true);
  await expect(page.getByRole("button", { name: /Starting .* scripted agents/ })).toBeDisabled();
  send!(JSON.stringify({ events: [running(2)] }));
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
});

test("D31 2.6 CO42 CO42a: four metric cells, named rates, chart, choices and dial percent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await separateStreams(page, [
    poolState(1, { synthetic: true }),
    { ...running(2), running: false },
    metrics(3, { landings_per_second: 4.25, escape_rate: 0.5 }),
    metrics(4, { landings_per_second: 5.5 }),
  ]);
  await serveSession(page, true);
  await page.goto(`/p/${POOL}`);
  await page.getByRole("button", { name: "Swarm", exact: true }).click();
  const cells = page.locator(".swarm-primary .swarm-cell");
  await expect(cells).toHaveCount(4);
  const boxes = await cells.evaluateAll((nodes) =>
    nodes.map((node) => {
      const b = node.getBoundingClientRect();
      return { x: b.x, width: b.width, y: b.y, border: getComputedStyle(node).borderRightWidth };
    }),
  );
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i]!.y).toBe(boxes[0]!.y);
    expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width - 1);
  }
  await expect(page.locator(".swarm-secondary")).toContainText("Escape rate – (target 0%)");
  await expect(page.locator(".swarm-chart polyline")).toHaveCount(1);
  for (const label of ["64", "256", "1,024", "2,048"])
    await expect(page.getByRole("radio", { name: label, exact: true })).toBeVisible();
  await expect(page.locator(".swarm-controls output")).toHaveText("40%");
  await page.getByRole("radio", { name: "1,024", exact: true }).check();
  await expect(page.getByRole("radio", { name: "1,024", exact: true })).toBeChecked();
});
