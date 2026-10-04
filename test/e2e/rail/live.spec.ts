// Rail states that the tracer recording does not show, driven over a WebSocket mock that answers
// `/api/pools/{pool}/stream` with fabricated events (`vite preview` serves no Worker). The event
// fields match `src/protocol/events.ts`; the expected sentences are the spec's own (BP1).

import { expect, test, type Page } from "@playwright/test";

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

function judged(n: number, key: string, result: "holds" | "confirm" | "repair" | null): Frame {
  return ev(n, {
    type: "premise.judged",
    attempt_id: "a_1",
    kind: "entity",
    key,
    old_hash: "h0",
    new_hash: "h1",
    cause: "landed 0",
    cause_seq: null,
    rule: "R1",
    class: "rule",
    result,
    reason: "",
    clef: { model: null, p: null, error: null },
  });
}

function recorded(n: number, key: string): Frame {
  return ev(n, {
    type: "premise.recorded",
    attempt_id: "a_1",
    premise: { kind: "entity", key, hash: "h0", seq: 0, read: true, edit: false, derived: false },
    tool: "read",
  });
}

/** Serves `/floor.json` and answers every stream socket with a snapshot, then `frames`. */
async function serveStream(page: Page, frames: Frame[], delayed: Frame[] = []): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      ws.send(JSON.stringify({ events: frames }));
      if (delayed.length > 0) {
        setTimeout(() => {
          ws.send(JSON.stringify({ events: delayed }));
        }, 3_000);
      }
    });
  });
}

test.describe("the attempt card over a live stream", () => {
  test("AC3/FL3: the card reads 'Landing…' until landing.landed, then 'Landed'", async ({ page }) => {
    await serveStream(
      page,
      [
        POOL_STATE,
        INTENT,
        OPENED,
        state(4, "opened", "working"),
        ev(5, {
          type: "submit.result",
          attempt_id: "a_1",
          submit_id: "s_1",
          status: "validated",
          tier: "auto",
          checks: [],
          duplicate: false,
        }),
        state(6, "working", "validated"),
        ev(7, {
          type: "landing.accepted",
          seq: 1,
          batch_id: 1,
          kind: "change",
          attempt_id: "a_1",
          change_id: "c_a_1",
          intent_id: "i_1",
          request_id: null,
          paths: ["creatures/fish.js"],
          writes: [],
        }),
        state(8, "validated", "accepted"),
      ],
      [
        ev(9, {
          type: "landing.landed",
          seq: 1,
          batch_id: 1,
          commit: "c0ffee",
          tree: "t1",
          note: "n1",
          note_json: "{}",
          time_to_land_ms: 100,
        }),
        ev(10, {
          type: "batch.pushed",
          batch_id: 1,
          first_seq: 1,
          last_seq: 1,
          main: "c0ffee",
          notes: "n1",
          tries: 1,
          ms: 100,
        }),
        state(11, "accepted", "landed"),
      ],
    );
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await expect(card).toBeVisible();
    // landing.accepted has arrived; landing.landed has not: the card reads "Landing…" (AC3).
    await expect(card.getByText("Landing…")).toBeVisible();
    await expect(card.getByText("Landed", { exact: true })).toHaveCount(0);
    // After landing.landed it reads "Landed" with `attempt.landed_as`.
    await expect(card.getByText("Landed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("On main as landing 1.")).toBeVisible();
  });

  test("CO14: non-holds lights are never hidden behind light.more", async ({ page }) => {
    const frames: Frame[] = [POOL_STATE, INTENT, OPENED, state(4, "opened", "working")];
    // changed + confirm + checking, then 13 holds: 16 lights for a LIGHTS_MAX of 14.
    frames.push(recorded(5, "fish.js#c"), judged(6, "fish.js#c", "repair"));
    frames.push(recorded(7, "fish.js#k"), judged(8, "fish.js#k", "confirm"));
    frames.push(recorded(9, "fish.js#s"), judged(10, "fish.js#s", null));
    for (let index = 0; index < 13; index += 1) frames.push(recorded(11 + index, `f.js#h${index}`));
    await serveStream(page, frames);
    await page.goto(`/p/${POOL}`);
    const lights = page.locator('.attempt-card[data-attempt-id="a_1"] .light');
    await expect(lights).toHaveCount(14);
    await expect(page.locator(".attempt-card__more")).toHaveText("+2");
    // Entity keys read "{name} in {file}" (keyLabel, 03 5.2); the words are the 5.3 table's.
    for (const name of ["c in fish.js: Changed.", "k in fish.js: Needs a confirm.", "s in fish.js: Being checked."]) {
      await expect(page.locator(`.light[aria-label^="${name}"]`)).toHaveCount(1);
    }
  });

  test("GA3: the sent-back count reads 'sent back 1 of 3'", async ({ page }) => {
    await serveStream(page, [
      POOL_STATE,
      INTENT,
      OPENED,
      state(4, "opened", "working"),
      state(5, "working", "going_around", { go_arounds: 1 }),
    ]);
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await expect(card.getByText("Going around")).toBeVisible();
    await expect(card.getByText("sent back 1 of 3")).toBeVisible();
  });

  test("CO13a/AC26: a summary_only pool's card shows no lights", async ({ page }) => {
    const summaryPool = { ...POOL_STATE, summary_only: true };
    await serveStream(page, [
      summaryPool,
      INTENT,
      OPENED,
      state(4, "opened", "working"),
      recorded(5, "fish.js#c"),
      judged(6, "fish.js#c", "repair"),
    ]);
    await page.goto(`/p/${POOL}`);
    const card = page.locator('.attempt-card[data-attempt-id="a_1"]');
    await expect(card).toBeVisible();
    await expect(card.locator(".light")).toHaveCount(0);
    await expect(card.getByText("Relies on")).toHaveCount(0);
  });
});
