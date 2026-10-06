// The undo sheet of 03-floor 3.12 (plan 2.6 item 5): opens from the Why card's `undo.open`
// (the sheet is no extra door, AC28), reads `undo.planning` while `GET .../undo-plan?seq=` is
// out, then shows the plan's sentences of 5.10 — `undo.title`, `undo.also`, `undo.kept`,
// `undo.in_flight` — with `undo.confirm` / `undo.cancel`. The confirm POSTs `/undo` with
// `expect_reverted` equal to the `reverted` list on screen (CO34a); `plan_changed` swaps in the
// response's plan under `undo.plan_changed` and asks again with nothing queued (FR31); other
// refusals read `undo.refused` and a stale POST reads the 409 row (5.9, FR23). Once Trunk
// accepts, the sheet reads `undo.landing` until the stream's undo landing lands, then
// `undo.done` (the landing is a streaming event, never the POST's doing). A visitor sends no
// request (3.12's held row — `shell.visitor` is the same flag everyone in Replay reads).
// Driven against the built Floor page: the stream is a routed WebSocket, the plan/undo routes
// are routed and asserted (4.5). Expected values come from the spec's copy tables, never from
// the page (BP1).

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  attemptOpened,
  attemptState,
  ev,
  FLOOR_JSON,
  intentCreated,
  POOL,
  poolState,
  serveSession,
} from "../shell/stream.ts";
import type { Frame } from "../shell/stream.ts";

/** The fake pool host: `__tap(path)` posts CO22's `tapped`, the way a creature opens its Why card. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__tap = function (path) {
    parent.postMessage({ type: "tapped", creature: "crab", path: path }, "*");
  };
  parent.postMessage({ type: "stats", source: location.pathname.split("/")[3], version: "c-1",
    seq: 1, tick: 1, paused: false, kinds: {}, shown: 0, total: 0, swap: null, selftest: null }, "*");
</script>`;

/** `landing.accepted`; the stream helpers of shell/stream.ts stop at attempts, so landings are
 * built here. `paths` matter: `files[path].last_landed_seq` is what the tapped creature asks for. */
function landingAccepted(
  n: number,
  seq: number,
  opts: { attempt?: string; intent?: string; kind?: string; request_id?: string; paths?: string[] },
): Frame {
  const kind = opts.kind ?? "change";
  return ev(n, {
    type: "landing.accepted",
    seq,
    batch_id: seq,
    kind,
    attempt_id: opts.attempt ?? null,
    change_id: opts.attempt !== undefined ? `c_${opts.attempt}` : `c_${kind}_${seq}`,
    intent_id: opts.intent ?? null,
    request_id: opts.request_id ?? null,
    paths: opts.paths ?? [],
    writes: (opts.paths ?? []).map((path) => ({
      kind: "file",
      key: path,
      old: "absent",
      new: `h-${seq}`,
    })),
  });
}

/** `landing.landed` with a note record, so the Why card is `live` without the note route (3.5). */
function landingLanded(n: number, seq: number): Frame {
  return ev(n, {
    type: "landing.landed",
    seq,
    batch_id: seq,
    commit: `commit-${seq}`,
    tree: `tree-${seq}`,
    note: `note-${seq}`,
    note_json: JSON.stringify({ v: 1, seq, kind: "change", change_id: `c_${seq}` }),
    time_to_land_ms: 100,
  });
}

/** An intent + working attempt that lands as `seq` (a change name `landing {seq} "{text}"`). */
function landChange(n: number, seq: number, attemptId: string, intentId: string, text: string, path: string): Frame[] {
  return [
    intentCreated(n, intentId, text),
    attemptOpened(n + 1, attemptId, intentId),
    attemptState(n + 2, attemptId, "opened", "working"),
    landingAccepted(n + 3, seq, { attempt: attemptId, intent: intentId, paths: [path] }),
    landingLanded(n + 4, seq),
  ];
}

/**
 * The pool the sheet is tested against: seq 1 the undo's target ("a crab that hides", the file
 * a tapped creature reports), seq 2 a later change the plan takes back, seq 3 a kept reader, and
 * a_9 in flight (the plan's `repairs` name it).
 */
const BASE_STREAM = [
  poolState(1),
  ...landChange(2, 1, "a_1", "i_1", "a crab that hides", "creatures/crab.js"),
  ...landChange(7, 2, "a_2", "i_2", "a faster crab", "creatures/fish.js"),
  ...landChange(12, 3, "a_3", "i_3", "reads the energy", "world/notes.md"),
  intentCreated(17, "i_9", "still swimming"),
  attemptOpened(18, "a_9", "i_9"),
  attemptState(19, "a_9", "opened", "working"),
];

/** The plan the `undo-plan` route answers unless a test says otherwise (01-core 11.3). */
const PLAN = {
  target_seq: 1,
  reverted: [1, 2],
  reopened: ["a_2"],
  kept_readers: [3],
  repairs: ["a_9"],
};

type Captured = { url: string; body: Record<string, unknown> | null };

/**
 * floor.json, the session, the pool frame's page, the two undo routes and the stream socket.
 * `plan`/`confirm` answer their route (default: PLAN / `{ok:true, request_id}` with the request's
 * own `request_id`, as Trunk answers UN5); `sent` captures the confirm POSTs and `planCalls` the
 * plan GETs' `seq` parameter.
 */
async function serve(
  page: Page,
  frames: Frame[],
  opts: {
    owner?: boolean;
    wsRef?: { ws?: { send: (m: string) => void } };
    sent?: Captured[];
    planCalls?: string[];
    plan?: (route: Route) => Promise<void>;
    confirm?: (route: Route) => Promise<void>;
  } = {},
): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(FLOOR_JSON) }),
  );
  await serveSession(page, opts.owner === true);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await page.route("**/api/pools/*/landings/*/note", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/pools/*/undo-plan**", async (route) => {
    opts.planCalls?.push(new URL(route.request().url()).searchParams.get("seq") ?? "");
    if (opts.plan !== undefined) return opts.plan(route);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, plan: PLAN }) });
  });
  await page.route("**/api/pools/*/undo", async (route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    opts.sent?.push({ url: route.request().url(), body });
    if (opts.confirm !== undefined) return opts.confirm(route);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, request_id: body["request_id"] }),
    });
  });
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    opts.wsRef && (opts.wsRef.ws = ws);
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
}

/** The live pool frame — `__tap` lives there. */
function poolFrame(page: Page) {
  return page.frames().find((f) => f.url().includes(`/pool/${POOL}/main/`));
}

/** Open the Why card of landing 1 through the tapped creature (CO22), then tap Undo. */
async function openUndoSheet(page: Page): Promise<void> {
  await expect.poll(async () => (await poolFrame(page)?.evaluate(() => true)) ?? false).toBe(true);
  await poolFrame(page)!.evaluate(() => (window as never as { __tap: (p: string) => void }).__tap("creatures/crab.js"));
  const why = page.locator(".why-sheet");
  await expect(why).toBeVisible();
  await why.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".undo-sheet")).toBeVisible();
}

test.describe("the undo sheet (3.12)", () => {
  test("opens from the Why card's Undo button: undo.planning, then the plan's 5.10 sentences (AC28)", async ({
    page,
  }) => {
    const planCalls: string[] = [];
    // Hold the plan answer until the planning state was observed, then release it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await serve(page, BASE_STREAM, {
      owner: true,
      planCalls,
      plan: async (route) => {
        await gate;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, plan: PLAN }),
        });
      },
    });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    // The plan request named the Why card's landing (4.5).
    await expect.poll(() => planCalls.length).toBe(1);
    expect(planCalls[0]).toBe("1");
    // While it is out: the loading row and the target's title.
    await expect(sheet.getByText("Working out what this undo takes back…")).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-label", 'Undo landing 1: "a crab that hides"?');
    release!();
    // The plan's sentences: also (one-form of undo.also), kept readers, in-flight repairs.
    await expect(
      sheet.getByText(
        'This also takes back 1 later change that was built on it: landing 2 "a faster crab". Its agent reopens and adapts.',
      ),
    ).toBeVisible();
    await expect(
      sheet.getByText('1 later changes only read it. They stay: landing 3 "reads the energy".'),
    ).toBeVisible();
    await expect(sheet.getByText('1 changes in flight get a heads-up: "still swimming".')).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Undo it" })).toBeEnabled();
    await expect(sheet.getByRole("button", { name: "Keep it" })).toBeVisible();
  });

  test("CO34a: Undo it POSTs seq and expect_reverted of the plan on screen, with a request_id", async ({ page }) => {
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Undo it" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.url).toContain(`/api/pools/${POOL}/undo`);
    expect(sent[0]!.body).toMatchObject({ seq: 1, expect_reverted: [1, 2] });
    expect(typeof sent[0]!.body!["request_id"]).toBe("string");
    // Accepted: the sheet reads undo.landing until the undo landing lands.
    await expect(sheet.getByText("Undo of landing 1 is landing…")).toBeVisible();
  });

  test("FR31/AC28: plan_changed shows the new plan under undo.plan_changed and asks again; nothing queued", async ({
    page,
  }) => {
    const sent: Captured[] = [];
    const nextPlan = { target_seq: 1, reverted: [1, 2, 3], reopened: ["a_2"], kept_readers: [], repairs: [] };
    let calls = 0;
    await serve(page, BASE_STREAM, {
      owner: true,
      sent,
      confirm: async (route) => {
        calls += 1;
        if (calls === 1) {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: false, reason: "plan_changed", plan: nextPlan }),
          });
        } else {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: true, request_id: "r_2" }),
          });
        }
      },
    });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Undo it" }).click();
    await expect.poll(() => sent.length).toBe(1);
    // The notice and the new plan's sentences; the button is live again (FR31).
    await expect(
      sheet.getByText("The pool changed while this was open. This is what the undo takes back now."),
    ).toBeVisible();
    await expect(
      sheet.getByText(
        'This also takes back 2 later changes that were built on it: landing 2 "a faster crab", landing 3 "reads the energy". Their agents reopen and adapt.',
      ),
    ).toBeVisible();
    const confirm = sheet.getByRole("button", { name: "Undo it" });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    // The second confirm carries the NEW plan's reverted list (CO34a) — not the old one.
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]!.body).toMatchObject({ seq: 1, expect_reverted: [1, 2, 3] });
    await expect(sheet.getByText("Undo of landing 1 is landing…")).toBeVisible();
  });

  test("3.12 error row: a plan refusal reads undo.refused with the reason sentence; a request never queued", async ({
    page,
  }) => {
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, {
      owner: true,
      sent,
      plan: async (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: false, reason: "already_undone" }),
        }),
    });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await expect(
      sheet.getByText("Trunk refused the undo: that landing is already undone. Nothing changed."),
    ).toBeVisible();
    // No plan, no buttons, and nothing ever went to /undo.
    await expect(sheet.getByRole("button", { name: "Undo it" })).toHaveCount(0);
    expect(sent.length).toBe(0);
  });

  test("3.12 error row: a confirm refusal of another reason keeps the sheet with undo.refused", async ({ page }) => {
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, {
      owner: true,
      sent,
      confirm: async (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: false, reason: "too_old" }),
        }),
    });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Undo it" }).click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(
      sheet.getByText("Trunk refused the undo: that landing is too far back. Nothing changed."),
    ).toBeVisible();
    await expect(sheet).toBeVisible();
  });

  test("FR23/5.9: a stale confirm (409) shows the request-error sentence and the sheet stays", async ({ page }) => {
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, {
      owner: true,
      sent,
      confirm: async (route) => route.fulfill({ status: 409, contentType: "application/json", body: "{}" }),
    });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Undo it" }).click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(sheet.getByText("This was already answered. The page shows the newest state.")).toBeVisible();
    await expect(sheet).toBeVisible();
  });

  test("FR29: undo.landing while the undo landing is in flight, undo.done once it lands", async ({ page }) => {
    const wsRef: { ws?: { send: (m: string) => void } } = {};
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, { owner: true, sent, wsRef });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Undo it" }).click();
    await expect.poll(() => sent.length).toBe(1);
    const requestId = sent[0]!.body!["request_id"] as string;
    // The stream's undo.planned under the confirm's request_id, then the undo landing accepted —
    // still only `undo.landing` (3.12's next-to-last row).
    wsRef.ws!.send(
      JSON.stringify({
        events: [
          ev(20, {
            type: "undo.planned",
            request_id: requestId,
            cause: "undo",
            target_seq: 1,
            reverted: [1, 2],
            reopened: ["a_2"],
            kept_readers: [3],
          }),
          ev(21, {
            type: "landing.accepted",
            seq: 4,
            batch_id: 4,
            kind: "undo",
            attempt_id: null,
            change_id: "c_undo_1",
            intent_id: null,
            request_id: requestId,
            paths: [],
            writes: [],
          }),
        ],
      }),
    );
    await expect(sheet.getByText("Undo of landing 1 is landing…")).toBeVisible();
    // …until the undo landing itself lands: `undo.done` names it (3.12's stopped row).
    wsRef.ws!.send(
      JSON.stringify({
        events: [
          ev(22, {
            type: "landing.landed",
            seq: 4,
            batch_id: 4,
            commit: "commit-4",
            tree: "tree-4",
            note: "note-4",
            note_json: null,
            time_to_land_ms: 50,
          }),
        ],
      }),
    );
    await expect(sheet.getByText("Undo of landing 1 landed as landing 4. It took back 2 changes.")).toBeVisible();
  });

  test("undo.cancel and Esc close the sheet and send nothing", async ({ page }) => {
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, { owner: true, sent });
    await page.goto(`/p/${POOL}`);
    await openUndoSheet(page);
    const sheet = page.locator(".undo-sheet");
    await sheet.getByRole("button", { name: "Keep it" }).click();
    await expect(sheet).toHaveCount(0);
    await openUndoSheet(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".undo-sheet")).toHaveCount(0);
    expect(sent.length).toBe(0);
  });

  test("3.12 held row: a visitor sends no undo-plan request; the sheet shows only the off state", async ({ page }) => {
    const planCalls: string[] = [];
    const sent: Captured[] = [];
    await serve(page, BASE_STREAM, { owner: false, planCalls, sent });
    await page.goto(`/p/${POOL}`);
    await expect.poll(async () => (await poolFrame(page)?.evaluate(() => true)) ?? false).toBe(true);
    await poolFrame(page)!.evaluate(() =>
      (window as never as { __tap: (p: string) => void }).__tap("creatures/crab.js"),
    );
    const why = page.locator(".why-sheet");
    await expect(why).toBeVisible();
    // 3.12's held row says a visitor has no Undo button on the Why card. The Why card is the
    // floor-pool lane's; if it still shows the button, the sheet itself must hold the line —
    // either way no request leaves and nothing is queued. (Replay reads the same shell.visitor.)
    const undoButton = why.getByRole("button", { name: "Undo" });
    if ((await undoButton.count()) > 0) {
      await undoButton.click();
      const sheet = page.locator(".undo-sheet");
      await expect(sheet.getByText("The owner key is needed for this. Unlock, then try again.")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Undo it" })).toHaveCount(0);
    }
    expect(planCalls.length).toBe(0);
    expect(sent.length).toBe(0);
  });
});
