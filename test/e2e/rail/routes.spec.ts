// 03-floor 13.6 (AC25): the client route `/p/{pool}` shows that pool as the main pool, and `/`
// shows the default pool of `/floor.json`. Both sockets are answered locally; each pool's stream
// carries a different intent text so the page shows which pool it took.

import { expect, test, type Page } from "@playwright/test";

const FLOOR_JSON = {
  default_pool: "alpha",
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: true, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: { "model-a": "model-a" },
  limits: [],
  related: "",
};

function frames(pool: string, intentText: string): Record<string, unknown>[] {
  const ev = (n: number, fields: Record<string, unknown>): Record<string, unknown> => ({
    n,
    t: 1_000 + n,
    ts: 1_000 + n,
    src: "trunk",
    pool,
    ...fields,
  });
  return [
    ev(1, {
      type: "pool.state",
      head_seq: 0,
      head_commit: "c-seed",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "c-seed",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://artifacts.invalid/pool",
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
      real_agents: 1,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
    }),
    ev(2, {
      type: "intent.created",
      intent_id: "i_1",
      text: intentText,
      requester: "owner",
      race: false,
      prewritten: false,
    }),
    ev(3, {
      type: "attempt.opened",
      attempt_id: "a_1",
      intent_id: "i_1",
      change_id: "c_a_1",
      agent: "real",
      model: "model-a",
      race: false,
    }),
    ev(4, {
      type: "attempt.state",
      attempt_id: "a_1",
      from: "opened",
      to: "working",
      transition: "T1",
      reason: null,
      go_arounds: 0,
      pull_backs: 0,
      right_of_way: false,
    }),
  ];
}

async function servePools(page: Page): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.routeWebSocket(/\/api\/pools\/([^/]+)\/stream/, (ws) => {
    const match = /\/api\/pools\/([^/]+)\/stream/.exec(ws.url());
    const pool = match?.[1] ?? "unknown";
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { type?: string };
      if (request.type !== "hello") return;
      ws.send(JSON.stringify({ type: "snapshot", head_seq: 0, events: [] }));
      for (const event of frames(pool, `${pool} intent`)) {
        ws.send(JSON.stringify({ type: "event", event }));
      }
    });
  });
}

test.describe("client routes (03-floor 13.6, AC25)", () => {
  test("/p/{pool} shows that pool as the main pool", async ({ page }) => {
    await servePools(page);
    await page.goto("/p/beta");
    await expect(page.getByText("beta intent")).toBeVisible();
    await expect(page.locator(".attempt-card").first()).toBeVisible();
  });

  test("/ shows the default pool of /floor.json", async ({ page }) => {
    await servePools(page);
    await page.goto("/");
    await expect(page.getByText("alpha intent")).toBeVisible();
  });
});
