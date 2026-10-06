// The Swarm view of 03-floor 3.15 (Slice 8 acceptance item 3), driven by streams built here:
//
//   - CO44: the SYNTHETIC banner of Swarm view names the agent count of the newest swarm.state
//     and says the scripted agents make no model calls;
//   - CO42/CO42a: the four large numbers, the false-abort rate and the escape rate are the
//     values of the newest `metrics` event — `strip.dash` before the first one arrives;
//   - CO44a/CO48: the owner controls show the newest swarm.state (dial and count), a dial move
//     during a run sends POST /api/swarm with { pool, running: true, collision_dial };
//   - a visitor (the "held" row of the state table) sees the numbers and no control.
//
// The fixture answers every stream socket with the same frames: EV2a puts swarm.state on every
// pool's stream, so the view reads it from the pool stream it is served.

import { expect, test, type Page } from "@playwright/test";
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

const SWARM = "swarm"; // FLOOR_JSON.swarm_pool

function swarmState(n: number, extra: Frame = {}): Frame {
  return ev(n, {
    src: "swarm",
    type: "swarm.state",
    synthetic: true,
    running: true,
    agents: 7,
    collision_dial: 0.3,
    pools: [SWARM, POOL],
    ...extra,
  });
}

const RUN = [
  poolState(1),
  intentCreated(2),
  attemptOpened(3, "a_1", "i_1", { agent: "synthetic" }),
  swarmState(4),
  metrics(5, {
    landings_per_second: 0.5,
    time_to_land_ms: { p50: 2_000, p99: 9_000 },
    go_around_rate: 0.25,
    false_abort_rate: 0.5,
    escape_rate: 0,
    waiting_behind: 3,
    push_backlog: 2,
  }),
];

async function openSwarm(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Swarm" }).first().click();
  await expect(page.locator(".swarm-view")).toBeVisible();
}

test.describe("CO44: the SYNTHETIC banner of Swarm view", () => {
  test("names the agent count of swarm.state and says no model calls are made", async ({ page }) => {
    await serveStream(page, RUN);
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);
    const banner = page.locator(".banner[data-tone='synthetic']");
    await expect(banner).toBeVisible();
    // 7 is the swarm.state count — the stream holds one synthetic attempt, so the wall cannot
    // be the source. The sentence is banner.synthetic.swarm.
    await expect(banner).toContainText("7 scripted agents");
    await expect(banner).toContainText("they make no model calls");
    await expect(banner).toContainText("same tools, premises and landing path");
  });
});

test.describe("CO42/CO42a: the numbers of the newest metrics event", () => {
  test("shows the metrics event's values, each under its window", async ({ page }) => {
    await serveStream(page, RUN);
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);
    const cells = page.locator(".swarm-numbers .swarm-cell");
    // The four large numbers of the metrics event, worked from its fields.
    await expect(cells.nth(0)).toContainText("0.50"); // landings_per_second
    await expect(cells.nth(0)).toContainText("last 60 s"); // swarm.window of window_ms
    await expect(cells.nth(1)).toContainText("2 s"); // time_to_land p50
    await expect(cells.nth(1)).toContainText("9 s"); // p99 in the sub-line
    await expect(cells.nth(2)).toContainText("25%"); // go_around_rate
    await expect(cells.nth(3)).toContainText("3"); // waiting_behind
    // The two small rates and the backlog.
    // The copy table's second {share} is the target: FALSE_ABORT_TARGET 5%, ESCAPE_TARGET 0%.
    await expect(page.locator(".swarm-numbers")).toContainText("False-abort rate 50% (target 5%)");
    await expect(page.locator(".swarm-numbers")).toContainText("Escape rate 0% (target 0%)");
    await expect(page.locator(".swarm-numbers")).toContainText("Push backlog 2");
  });

  test("a newer metrics event replaces the numbers; before one, every value is a dash", async ({ page }) => {
    await serveStream(
      page,
      [poolState(1), swarmState(2)], // running, but no metrics event yet
      [
        metrics(3, { landings_per_second: 1 }),
        metrics(4, { landings_per_second: 0.75, go_around_rate: 0.5, waiting_behind: 9 }),
      ],
    );
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);
    // Before the first metrics event every number is strip.dash.
    const cells = page.locator(".swarm-numbers .swarm-cell .strip-value");
    for (let i = 0; i < 4; i += 1) await expect(cells.nth(i)).toHaveText("–");
    await expect(page.locator(".swarm-numbers")).not.toContainText("%");
    // After the delayed frames the NEWEST event wins: lps 0.75 (not 1.00), gar 50%, waiting 9.
    await expect(page.locator(".swarm-numbers")).toContainText("0.75");
    await expect(page.locator(".swarm-numbers")).toContainText("50%");
    await expect(page.locator(".swarm-numbers")).not.toContainText("1.00");
    await expect(page.locator(".swarm-numbers")).toContainText("9");
  });

  test("no swarm.state at all shows the empty state, controls for the owner only", async ({ page }) => {
    await serveStream(page, [poolState(1)]);
    await serveSession(page, true);
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);
    await expect(page.locator(".swarm-view")).toContainText("No Swarm run yet");
    await expect(page.locator(".swarm-controls")).toBeVisible();
  });
});

test.describe("CO44a/CO48: the owner controls send SwarmRequest and follow swarm.state", () => {
  test("the dial shows the stream's value and a move POSTs { pool, running, collision_dial }", async ({ page }) => {
    const posts: Frame[] = [];
    await serveStream(page, RUN);
    await serveSession(page, true);
    await page.route("**/api/swarm", async (route) => {
      const request = route.request();
      if (request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}") as Frame);
      await route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    });
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);

    // CO48: the control reads the newest swarm.state — dial 0.3, agents 7, not the page's.
    const dial = page.locator('.swarm-controls input[type="range"]');
    const agentsField = page.locator('.swarm-controls input[type="number"]');
    await expect(dial).toHaveValue("0.3");
    await expect(agentsField).toHaveValue("7");

    // Moving the dial during a run (step 0.05: one ArrowRight takes 0.3 to 0.35).
    await dial.focus();
    await dial.press("ArrowRight");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ pool: SWARM, running: true, collision_dial: 0.35 });
    expect(typeof posts[0]!["request_id"]).toBe("string");
    // The dial move sends no swarm config — only the request the spec names.
    expect(posts[0]).not.toHaveProperty("agents");
    expect(posts[0]).not.toHaveProperty("seed");
  });

  test("Stop sends { pool, running: false }", async ({ page }) => {
    const posts: Frame[] = [];
    await serveStream(page, RUN);
    await serveSession(page, true);
    await page.route("**/api/swarm", async (route) => {
      const request = route.request();
      if (request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}") as Frame);
      await route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    });
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);

    // `exact`: the header's kill switch ("Stop all agents") also contains the word.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ pool: SWARM, running: false });
    expect(typeof posts[0]!["request_id"]).toBe("string");
  });

  test("Start sends the whole SwarmConfig (SWR1): the controls' values and the deployment's defaults", async ({
    page,
  }) => {
    const posts: Frame[] = [];
    // A stopped run: the controls adopt its agent count and dial (CO48), and Start is offered.
    await serveStream(page, [poolState(1), swarmState(2, { running: false })]);
    await serveSession(page, true);
    await page.route("**/api/swarm", async (route) => {
      const request = route.request();
      if (request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}") as Frame);
      await route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    });
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    // SWR1: a request that starts agents carries all of SwarmConfig — agents and dial from the
    // newest swarm.state (7, 0.3), the rest from /floor.json's swarm_defaults (FLOOR_JSON).
    expect(posts[0]).toMatchObject({
      pool: SWARM,
      running: true,
      agents: 7,
      collision_dial: 0.3,
      ...FLOOR_JSON.swarm_defaults,
    });
    expect(typeof posts[0]!["request_id"]).toBe("string");
  });
});

test.describe("the visitor row of the state table", () => {
  test("a visitor sees the wall and the numbers but no control", async ({ page }) => {
    await serveStream(page, RUN);
    await serveSession(page, false);
    await page.goto(`/p/${POOL}`);
    await openSwarm(page);
    await expect(page.locator(".swarm-controls")).toHaveCount(0);
    await expect(page.locator('.swarm-view input[type="range"]')).toHaveCount(0);
    // The numbers and the banner are a visitor's too (the state table's "held" row keeps them).
    await expect(page.locator(".swarm-numbers")).toContainText("0.50");
    await expect(page.locator(".banner[data-tone='synthetic']")).toContainText("7 scripted agents");
    // The wall cell of the one synthetic attempt is drawn.
    await expect(page.locator(".swarm-tile")).toHaveCount(1);
  });
});
