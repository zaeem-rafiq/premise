// Shared helpers for the shell specs: a fixed /floor.json, a WebSocket mock that answers
// /api/pools/{pool}/stream with fabricated frames, and the owner-session routes. The
// fixture project serves the built Floor with no Worker, so every API answer is scripted
// here. The event fields match src/protocol/events.ts; expected sentences come from the
// specification and the copy table, never from what the page happens to draw (BP1).

import type { Page } from "@playwright/test";

export const POOL = "testpool";

export const FLOOR_JSON = {
  default_pool: POOL,
  swarm_pool: "swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: true, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
  models: { "model-a": "model-a" },
  limits: ["at most 6 real agents", "a spend cap of $40.00"],
  related: "",
};

export type Frame = Record<string, unknown>;

export function ev(n: number, fields: Frame): Frame {
  return { n, t: 1_000 + n, ts: 1_000 + n, src: "trunk", pool: POOL, ...fields };
}

/** A ready pool; the extras move it to paused / rebuilding / synthetic. */
export function poolState(n: number, extra: Frame = {}): Frame {
  return ev(n, {
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
    real_agents: 4,
    max_real_agents: 6,
    synthetic: false,
    summary_only: false,
    ...extra,
  });
}

export function intentCreated(n: number, id = "i_1", text = "a tracer fish"): Frame {
  return ev(n, {
    type: "intent.created",
    intent_id: id,
    text,
    requester: "owner",
    race: false,
    prewritten: false,
  });
}

export function attemptOpened(n: number, attemptId = "a_1", intentId = "i_1", extra: Frame = {}): Frame {
  return ev(n, {
    type: "attempt.opened",
    attempt_id: attemptId,
    intent_id: intentId,
    change_id: `c_${attemptId}`,
    agent: "real",
    model: "model-a",
    race: false,
    ...extra,
  });
}

export function attemptState(n: number, attemptId: string, from: string, to: string, extra: Frame = {}): Frame {
  return ev(n, {
    type: "attempt.state",
    attempt_id: attemptId,
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

export function poolPaused(n: number, reason: string): Frame {
  return ev(n, { type: "pool.paused", reason, detail: "push_rejected" });
}

export function limits(
  n: number,
  opts: { spend: number; cap: number; killed?: boolean; refusing?: boolean; models?: Frame[] },
): Frame {
  return ev(n, {
    type: "limits",
    spend_usd: opts.spend,
    reserved_usd: 0,
    cap_usd: opts.cap,
    killed: opts.killed ?? false,
    refusing: opts.refusing ?? false,
    models: opts.models ?? [],
  });
}

export function metrics(n: number, extra: Frame = {}): Frame {
  return ev(n, {
    type: "metrics",
    window_ms: 60_000,
    landings_per_second: 0,
    time_to_land_ms: { p50: null, p99: null },
    time_held_ms: { p50: null, p99: null },
    go_around_rate: null,
    false_abort_rate: null,
    escape_rate: null,
    waiting_behind: 0,
    push_backlog: 0,
    tick_cpu_ms: { p50: null, p99: null },
    ...extra,
  });
}

export function cardOpened(n: number, card: Frame): Frame {
  return ev(n, { type: "card.opened", card });
}

export function choiceCard(id: string, reason: string, title: string): Frame {
  return {
    card_id: id,
    kind: "choice",
    attempt_ids: ["a_1"],
    intent_ids: ["i_1"],
    submit_ids: {},
    title,
    body: ["The owner decides in plain words."],
    options: [
      { id: "retry", label: "Try again" },
      { id: "stop", label: "Stop" },
    ],
    paths: [],
    blast_radius: {},
    preview: null,
    candidates: null,
    risk: null,
    reason,
  };
}

/** Serves /floor.json and answers every stream socket with `frames`, then `delayed`
 * after 3 s (the rail spec's pattern). */
export async function serveStream(
  page: Page,
  frames: Frame[],
  delayed: Frame[] = [],
  floor: Frame = FLOOR_JSON,
): Promise<void> {
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(floor) }),
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

/** The session answers: GET /api/session -> { owner }, POST /api/session -> 200 { owner },
 * DELETE -> 200. `onPost` sees each unlock body's key for AC16. */
export async function serveSession(
  page: Page,
  owner: boolean,
  onPost?: (key: string | undefined) => void,
): Promise<void> {
  await page.route("**/api/session", (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ owner }),
      });
    }
    if (request.method() === "POST") {
      try {
        onPost?.((JSON.parse(request.postData() ?? "{}") as { key?: string }).key);
      } catch {
        onPost?.(undefined);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ owner: true }) });
    }
    return route.fulfill({ status: 200, body: "{}" });
  });
}
