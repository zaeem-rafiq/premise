// Outside agents over MCP on the Floor (07-mcp MC24): the attempt card of an outside attempt shows
// the client's name as its model short name and the tag `attempt.tag.mcp`, over a mocked stream.
// Expected words come from 07-mcp and the copy table of 03-floor 5.4, never from the page (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const POOL = "testpool";
const FLOOR = readFileSync(join(process.cwd(), "docs/spec/03-floor.md"), "utf8");

/** A copy id's text from the copy tables of 03-floor section 5: the row `| \`id\` | text |`. */
function copy(id: string): string {
  const row = new RegExp(`^\\| \`${id.replaceAll(".", "\\.")}\` \\| (.*) \\|$`, "m").exec(FLOOR);
  if (row === null) throw new Error(`no copy row ${id}`);
  return row[1]!;
}

const FLOOR_JSON = {
  default_pool: POOL,
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: false, attempt_repos: false, mcp: true },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: {},
  limits: [],
  related: "",
};

type Frame = Record<string, unknown>;

function ev(n: number, fields: Frame): Frame {
  return { n, t: 1_000 + n, ts: 1_000 + n, src: "trunk", pool: POOL, ...fields };
}

const FRAMES: Frame[] = [
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
    app: null,
  }),
  ev(2, {
    type: "intent.created",
    intent_id: "i_1",
    text: "a jellyfish that drifts up and down",
    requester: "owner",
    race: false,
    prewritten: false,
  }),
  // MC12: an outside attempt is real, and its model field is mcp/<client name>.
  ev(3, {
    type: "attempt.opened",
    attempt_id: "a_1",
    intent_id: "i_1",
    change_id: "c_1",
    agent: "real",
    model: "mcp/claude-code",
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

async function serve(page: Page): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ owner: false }) }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: FRAMES }));
    });
  });
}

test("MC24: an outside agent's attempt card shows the client's name and the tag of an outside agent", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serve(page);
  await page.goto(`/p/${POOL}`);
  const card = page.locator(".attempt-card").filter({ hasText: "a jellyfish that drifts up and down" });
  await expect(card).toHaveCount(1);
  // 03-floor 5.2: the model short name is the last segment of the id — the client's name.
  await expect(card.locator(".attempt-card__model").first()).toHaveText("claude-code");
  await expect(card.locator(".attempt-card__tag").filter({ hasText: copy("attempt.tag.mcp") })).toHaveCount(1);
  await expect(card.locator(".attempt-card__tag").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("mcp-card.png") });
});
