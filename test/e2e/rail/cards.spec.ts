// The rail's card surface over the mocked stream: the tray and the no-frames card sheet
// (03-floor 3.13, 3.14; plan 2.6 item 5), the one-request rule of AC17, AC22's option-id
// requests, AC26's `rail.summary_only`, AC27's `sent_back_n`, AC8's markup-as-text and FL7's
// disabled visitor box. Expected values come from the spec's copy tables, never the page (BP1).

import { expect, test, type Page, type Route } from "@playwright/test";

const POOL = "testpool";

const FLOOR_JSON = {
  default_pool: POOL,
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: true, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: { "model-a": "model-a" },
  limits: [],
  related: "",
};

/** The same page with `features.held` false: the minimal held card of HD1 (plan 2.6 item 5). */
const FLOOR_JSON_MINIMAL = {
  ...FLOOR_JSON,
  features: { ...FLOOR_JSON.features, held: false },
};

type Frame = Record<string, unknown>;

function ev(n: number, fields: Frame): Frame {
  return { n, t: 1_000 + n, ts: 1_000 + n, src: "trunk", pool: POOL, ...fields };
}

const POOL_STATE = ev(1, {
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
});

const INTENT = ev(2, {
  type: "intent.created",
  intent_id: "i_1",
  text: "a tracer fish",
  requester: "owner",
  race: false,
  prewritten: false,
});

const OPENED = ev(3, {
  type: "attempt.opened",
  attempt_id: "a_1",
  intent_id: "i_1",
  change_id: "c_a_1",
  agent: "real",
  model: "model-a",
  race: false,
});

function state(n: number, from: string, to: string, extra: Frame = {}): Frame {
  return ev(n, {
    type: "attempt.state",
    attempt_id: "a_1",
    from,
    to,
    transition: `T-${from}-${to}`,
    reason: null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
    ...extra,
  });
}

function submit(n: number, attemptId = "a_1", submitId = "s_1"): Frame {
  return ev(n, {
    type: "submit.result",
    attempt_id: attemptId,
    submit_id: submitId,
    status: "validated",
    tier: "held",
    checks: [{ name: "typecheck", ok: true }],
    duplicate: false,
  });
}

/** A `card.opened` frame (03 4.3): the card fields are the ones `Card` carries (01-core 10.3). */
function cardOpened(n: number, card: Frame): Frame {
  return ev(n, { type: "card.opened", card });
}

const HELD_CARD = {
  card_id: "card_1",
  kind: "held",
  attempt_ids: ["a_1"],
  intent_ids: ["i_1"],
  submit_ids: { a_1: "s_1" },
  title: "This change touches shared rules. Land it?",
  body: ["It changes world/energy.js."],
  options: [
    { id: "land", label: "Land" },
    { id: "decline", label: "Decline" },
  ],
  paths: [{ path: "world/energy.js", tier: "held" }],
  blast_radius: { a_1: { repair: [], confirm: [], triage: [], right_of_way: [] } },
  preview: null,
  candidates: null,
  risk: null,
  reason: "held_path",
};

const CHOICE_CARD = {
  card_id: "card_2",
  kind: "choice",
  attempt_ids: ["a_1"],
  intent_ids: ["i_1"],
  submit_ids: {},
  title: "This change contradicts a landed one.",
  body: ["The owner decides which reading stays."],
  options: [
    { id: "retry", label: "Try again" },
    { id: "stop", label: "Stop" },
  ],
  paths: [],
  blast_radius: {},
  preview: null,
  candidates: null,
  risk: null,
  reason: "contradiction",
};

/** The CARD_OPTION ids of `01-core.md` 10.3 — the only ids a request may carry (CD4). */
const CARD_OPTIONS = new Set(["land", "land_now", "decline", "retry", "stop", "keep_landed", "new_attempt", "choose"]);

type CapturedRequest = { url: string; body: Record<string, unknown> };

/**
 * Serves `/floor.json`, the session and the stream; when `owner` the session answers
 * `{ owner: true }`. Card-action and stop POSTs are captured into `sent` and held back
 * `holdMs` so a fast second tap happens while the first is in flight (AC17).
 */
async function serve(
  page: Page,
  frames: Frame[],
  opts: { owner?: boolean; floorJson?: Frame; holdMs?: number; sent?: CapturedRequest[] } = {},
): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(opts.floorJson ?? FLOOR_JSON) }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ owner: opts.owner === true }) }),
  );
  const answer = async (route: Route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    opts.sent?.push({ url: route.request().url(), body });
    if (opts.holdMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.holdMs));
    await route.fulfill({ contentType: "application/json", body: "{}" });
  };
  await page.route("**/api/pools/*/cards/*", answer);
  await page.route("**/api/pools/*/attempts/*/stop", answer);
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
}

test.describe("the tray and the card sheet", () => {
  test("plan 2.6 item 5, AC22: with features.held false the minimal held sheet carries the card's own text and options (HD1, CD4, CD5)", async ({
    page,
  }) => {
    const sent: CapturedRequest[] = [];
    await serve(
      page,
      [POOL_STATE, INTENT, OPENED, state(4, "opened", "working"), submit(5), state(6, "working", "held"), cardOpened(7, HELD_CARD)],
      { owner: true, floorJson: FLOOR_JSON_MINIMAL, sent },
    );
    await page.goto(`/p/${POOL}`);
    // The tray row: the card's title and `card.open` (03 3.13).
    const tray = page.locator(".tray");
    await expect(tray.getByText("This change touches shared rules. Land it?")).toBeVisible();
    await tray.getByRole("button", { name: "Open" }).click();
    // The minimal form (HD1): title, body, the intent, held.changes, the reason field, two buttons.
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("This change touches shared rules. Land it?")).toBeVisible();
    await expect(sheet.getByText("It changes world/energy.js.")).toBeVisible();
    await expect(sheet.getByText('owner: "a tracer fish"')).toBeVisible();
    await expect(sheet.getByText("What it changes")).toBeVisible();
    await expect(sheet.getByText("world/energy.js", { exact: false }).first()).toBeVisible();
    await expect(sheet.getByLabel(/Reason/)).toBeVisible();
    // No held.affects, no risk lines in the minimal form.
    await expect(sheet.getByText("Who it affects")).toHaveCount(0);
    await expect(sheet.getByText(/Does what was asked/)).toHaveCount(0);
    // The buttons are the card's options, in order, the first (Land) the primary at the right.
    const buttons = sheet.locator(".card-sheet__actions button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText("Decline");
    await expect(buttons.nth(1)).toHaveText("Land");
    // A tap sends the option's id and the card's submit_ids, nothing outside CardOption (CD4).
    await buttons.nth(1).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.url).toContain(`/api/pools/${POOL}/cards/card_1`);
    expect(sent[0]!.body["option"]).toBe("land");
    expect(CARD_OPTIONS.has(String(sent[0]!.body["option"]))).toBe(true);
    expect(sent[0]!.body["submit_ids"]).toEqual({ a_1: "s_1" });
    expect(typeof sent[0]!.body["request_id"]).toBe("string");
    expect(sent[0]!.body["attempt_id"]).toBeUndefined();
  });

  test("AC22: a choice card shows exactly its options, and a tap sends that option's id (CD4, CD5)", async ({
    page,
  }) => {
    const sent: CapturedRequest[] = [];
    await serve(
      page,
      [POOL_STATE, INTENT, OPENED, state(4, "opened", "working"), cardOpened(5, CHOICE_CARD)],
      { owner: true, sent },
    );
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const sheet = page.locator(".card-sheet");
    await expect(sheet.getByText("This change contradicts a landed one.")).toBeVisible();
    const buttons = sheet.locator(".card-sheet__actions button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText("Stop");
    await expect(buttons.nth(1)).toHaveText("Try again");
    await buttons.nth(1).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.body["option"]).toBe("retry");
    expect(CARD_OPTIONS.has(String(sent[0]!.body["option"]))).toBe(true);
  });

  test("AC17: two fast taps on Land send one request (CO2)", async ({ page }) => {
    const sent: CapturedRequest[] = [];
    await serve(
      page,
      [POOL_STATE, INTENT, OPENED, state(4, "opened", "working"), submit(5), state(6, "working", "held"), cardOpened(7, HELD_CARD)],
      { owner: true, sent, holdMs: 400 },
    );
    await page.goto(`/p/${POOL}`);
    await page.locator(".tray").getByRole("button", { name: "Open" }).click();
    const land = page.locator(".card-sheet").getByRole("button", { name: "Land" });
    await land.click();
    await land.click({ force: true });
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(600);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body["option"]).toBe("land");
  });

  test("AC17: two fast taps on the owner's Stop send one request (CO2)", async ({ page }) => {
    const sent: CapturedRequest[] = [];
    await serve(page, [POOL_STATE, INTENT, OPENED, state(4, "opened", "working")], {
      owner: true,
      sent,
      holdMs: 400,
    });
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await card.locator(".attempt-card__intent").click(); // expand (03 3.2)
    const stop = card.getByRole("button", { name: "Stop this agent" });
    await stop.click();
    await stop.click({ force: true });
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(600);
    expect(sent.length).toBe(1);
    expect(sent[0]!.url).toContain(`/api/pools/${POOL}/attempts/a_1/stop`);
    expect(typeof sent[0]!.body["request_id"]).toBe("string");
  });

  test("AC26: a summary_only pool ends the working list with rail.summary_only", async ({ page }) => {
    const summaryPool = { ...POOL_STATE, summary_only: true };
    await serve(
      page,
      [summaryPool, INTENT, OPENED, state(4, "opened", "working")],
      {},
    );
    await page.goto(`/p/${POOL}`);
    await expect(page.locator('.attempt-card[data-attempt-id="a_1"]')).toBeVisible();
    await expect(
      page.getByText("This pool reports summaries only. Lights, steps and diffs are not in its stream."),
    ).toBeVisible();
  });

  test("AC27: the card shows attempt.sent_back_n as go_arounds + pull_backs (GA3)", async ({ page }) => {
    await serve(
      page,
      [POOL_STATE, INTENT, OPENED, state(4, "opened", "working"), state(5, "working", "working", { go_arounds: 1, pull_backs: 1 })],
      {},
    );
    await page.goto(`/p/${POOL}`);
    await expect(
      page.locator('.attempt-card[data-attempt-id="a_1"]').getByText("sent back 2 of 3"),
    ).toBeVisible();
  });

  test("AC8: markup in intent text, a statement and a path is shown as text (FL8)", async ({ page }) => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const frames = [
      POOL_STATE,
      ev(2, { type: "intent.created", intent_id: "i_1", text: evil, requester: "owner", race: false, prewritten: false }),
      OPENED,
      state(4, "opened", "working"),
      ev(5, {
        type: "op.recorded",
        attempt_id: "a_1",
        op_seq: 1,
        op: "write",
        path: "evil<b>.js",
        targets: [],
        altered: [],
        added: ["evil<b>.js#x"],
        removed: [],
      }),
      ev(6, {
        type: "headsup.sent",
        attempt_id: "a_1",
        hn: 1,
        result: "repair",
        wake: true,
        cause: { type: "landing", seqs: [1], changes: [] },
        keys: [{ kind: "entity", key: "evil<b>.js#x", rule: "E1" }],
        items: null,
        dropped_ops: [],
        go_around: 1,
      }),
      ev(7, {
        type: "headsup.resolved",
        attempt_id: "a_1",
        hn: 1,
        result: "repair",
        go_around: 1,
        changed: true,
        statement: `<i>done</i>${evil}`,
      }),
    ];
    await serve(page, frames, {});
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await expect(card.getByText(`“${evil}”`)).toBeVisible(); // the intent text as text, quotes added
    await expect(card.locator("img")).toHaveCount(0);
    // The `repair` heads-up opened the card by itself (CO11); nothing to click.
    await expect(card.getByText("evil<b>.js", { exact: false }).first()).toBeVisible();
    await expect(card.getByText("<i>done</i>", { exact: false }).first()).toBeVisible();
    await expect(card.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test("FL7: a visitor's intent box stays, disabled, and says why", async ({ page }) => {
    await serve(page, [POOL_STATE], { owner: false });
    await page.goto(`/p/${POOL}`);
    const field = page.locator(".intent-box textarea");
    await expect(field).toBeDisabled();
    await expect(
      page.getByText("Only the owner can send requests. You can watch, open Why cards and play the Replay."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  });
});
