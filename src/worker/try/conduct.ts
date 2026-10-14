// The try conductor (09-try TY8, TY9): plays `tryScript` in a visitor's try pool on the server.
// Every effect is a durable Workflow step — a launch, a release, a tap, a read of the pool's
// events — and every decision is made from step results, so a resumed instance replays the same
// conductor to the same place and repeats no launch (the attempt ids derive from the request id,
// 9.8). It launches only the canned cast, as SWR2 does, and never calls a model (TY5).
//
// Extracted from the Workflow entrypoint so a unit test can drive it with a fake step and a fake
// `env`: `cloudflare:workers` is a type-only import here.

import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { CardOption } from "../../protocol/cards.ts";
import { patternById } from "../../swarm/pattern.ts";
import { tryConductor } from "../../swarm/try-script.ts";
import { heldAttempts, launchAgent, launchId, releaseAgent } from "../swarm/launch.ts";

/** TY8: the pause before each row's actions, so a visitor who has just opened the pool sees it. */
export const TRY_BEAT_MS = 6000;
/** TY9: the longest a try conductor runs. */
export const TRY_DEADLINE_MS = 600_000;
/** How long one read step waits for new events before it answers none. */
const READ_WAIT_MS = 20_000;
const READ_POLL_MS = 500;
/** The most events one read step hands back: a step's result stays small. */
const READ_BATCH = 200;
/** SWR2's launch fields for the canned cast, as the rehearsal conductor sends them. */
const CAST_SEED = 7;
const CAST_THINK_MS: [number, number] = [0, 0];

const STEP_RETRY = { retries: { limit: 5, delay: 1000, backoff: "exponential" as const } };

/** The Workflow instance's parameters (TY9): the pool it drives. */
export type TryParams = { pool: string };

/** A card as the conductor keeps it: what the tap needs (CD4) and what a row matches. */
export type TryCard = {
  card_id: string;
  kind: string;
  attempt_ids: string[];
  submit_ids: Record<string, string>;
  options: string[];
};

/** The fields of an event the conductor reads; the rest of the event stays in the Floor. */
export type TryEvent = {
  type: string;
  n: number;
  attempt_id?: string;
  card_id?: string;
  seq?: number;
  path?: string;
  result?: string;
  through_seq?: number;
  status?: string;
  action?: string;
  kind?: string;
  card?: TryCard;
};

/** The step methods the conductor uses. */
export type TryStep = Pick<WorkflowStep, "do" | "sleep">;

export type TryOutcome = "done" | "killed" | "pool_failed" | "deadline";

const STRING_FIELDS = ["attempt_id", "card_id", "path", "result", "status", "action", "kind"] as const;
const NUMBER_FIELDS = ["seq", "through_seq"] as const;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Keeps what `createConductor` matches on and what a tap needs (TY8). */
export function projectEvent(event: Record<string, unknown>): TryEvent {
  const out: TryEvent = { type: String(event.type), n: Number(event.n) };
  for (const key of STRING_FIELDS) if (typeof event[key] === "string") out[key] = event[key];
  for (const key of NUMBER_FIELDS) if (typeof event[key] === "number") out[key] = event[key];
  const card = event.card;
  if (typeof card === "object" && card !== null) {
    const c = card as Record<string, unknown>;
    const submitIds: Record<string, string> = {};
    if (typeof c.submit_ids === "object" && c.submit_ids !== null) {
      for (const [k, v] of Object.entries(c.submit_ids)) if (typeof v === "string") submitIds[k] = v;
    }
    out.card = {
      card_id: String(c.card_id),
      kind: String(c.kind),
      attempt_ids: strings(c.attempt_ids),
      submit_ids: submitIds,
      options: Array.isArray(c.options) ? strings(c.options.map((o) => (o as { id?: unknown }).id)) : [],
    };
  }
  return out;
}

async function killed(env: Env): Promise<boolean> {
  try {
    const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/killed");
    if (!response.ok) return false;
    return ((await response.json()) as { killed?: unknown }).killed === true;
  } catch {
    return false;
  }
}

/** The pool's events after `cursor`, from its Floor's export (RP1), projected. */
async function eventsAfter(env: Env, pool: string, cursor: number): Promise<TryEvent[]> {
  const response = await env.FLOOR.get(env.FLOOR.idFromName(pool)).fetch(
    `https://floor/api/pools/${encodeURIComponent(pool)}/replay.ndjson`,
  );
  if (response.status === 404) return []; // FR30: no event yet
  if (!response.ok) throw new Error(`floor export ${response.status}`);
  const lines = (await response.text()).split("\n").filter((line) => line !== "");
  const events: TryEvent[] = [];
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.n === "number" && event.n > cursor) events.push(projectEvent(event));
    if (events.length >= READ_BATCH) break;
  }
  return events;
}

/** One read step: waits up to `READ_WAIT_MS` for events after `cursor`. `now` is the step's
 * clock, so the deadline check replays identically. */
async function readEvents(env: Env, pool: string, cursor: number): Promise<{ events: TryEvent[]; now: number }> {
  const until = Date.now() + READ_WAIT_MS;
  for (;;) {
    const events = await eventsAfter(env, pool, cursor);
    if (events.length > 0 || Date.now() >= until) return { events, now: Date.now() };
    await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS));
  }
}

/** SWR2's launch of the named patterns, with `hold` for those listed (SWR3). */
async function startPatterns(
  env: Env,
  pool: string,
  requestId: string,
  patterns: readonly string[],
  hold: readonly string[],
): Promise<{ killed: boolean; launched: string[] }> {
  if (await killed(env)) return { killed: true, launched: [] };
  const launched: string[] = [];
  for (const [n, id] of patterns.entries()) {
    const pattern = patternById(id);
    if (pattern === undefined) throw new Error(`unknown pattern ${id}`);
    const attemptId = launchId("a_", requestId, n);
    const result = await launchAgent(env, {
      pool,
      attemptId,
      intentId: launchId("i_", requestId, n),
      pattern: { id: pattern.id, intent: pattern.intent, truth: pattern.truth },
      seed: CAST_SEED,
      agentN: n,
      hold: hold.includes(id),
      thinkMs: CAST_THINK_MS,
    });
    if (!result.ok) throw new Error(`launch ${result.code}`);
    launched.push(attemptId);
  }
  return { killed: false, launched };
}

/** SWR3's release of every held attempt of the named patterns. */
async function releasePatterns(env: Env, pool: string, patterns: readonly string[]): Promise<string[]> {
  const released: string[] = [];
  for (const id of patterns) {
    for (const attemptId of await heldAttempts(env, pool, id)) {
      await releaseAgent(env, pool, id, attemptId);
      released.push(attemptId);
    }
  }
  return released;
}

/** The owner's tap of CD4, made by the conductor: Trunk's `card_action` entry. */
async function tapCard(
  env: Env,
  pool: string,
  card: { card_id: string; submit_ids: Record<string, string> },
  option: CardOption,
  requestId: string,
): Promise<{ ok: boolean; stale: boolean }> {
  const response = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch(
    `https://trunk/api/pools/${encodeURIComponent(pool)}/cards/${encodeURIComponent(card.card_id)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option, submit_ids: card.submit_ids, request_id: requestId }),
    },
  );
  if (!response.ok) throw new Error(`card ${response.status}`);
  const body = (await response.json()) as { ok?: unknown; stale?: unknown };
  return { ok: body.ok === true, stale: body.stale === true };
}

/** TY8, TY9: plays the try conductor to its end. */
export async function runTry(env: Env, params: TryParams, step: TryStep): Promise<TryOutcome> {
  const pool = params.pool;
  const conductor = tryConductor();
  const bindings = new Map<string, string>();
  const cards = new Map<string, TryCard>();
  let cursor = 0;
  let started: number | null = null;
  let actionN = 0;
  let tapN = 0;
  let readN = 0;
  let pendingTap: CardOption | null = null;

  for (;;) {
    const actions = conductor.takeActions();
    if (actions.length > 0) await step.sleep(`beat-${actionN + 1}`, TRY_BEAT_MS);
    for (const action of actions) {
      actionN += 1;
      if (action.type === "start") {
        const requestId = `${pool}-start-${actionN}`;
        const result = await step.do(`start-${actionN}`, STEP_RETRY, () =>
          startPatterns(env, pool, requestId, action.patterns, action.hold_before_submit),
        );
        if (result.killed) return "killed";
        action.patterns.forEach((pattern, i) => {
          const id = result.launched[i];
          if (id === undefined) return;
          bindings.set(pattern, id);
          conductor.bind(pattern, id);
        });
      } else if (action.type === "release") {
        await step.do(`release-${actionN}`, STEP_RETRY, () => releasePatterns(env, pool, action.patterns));
      } else if (action.type === "tap") {
        pendingTap = action.option;
      }
      // `open_compare` and `probe` need a browser; TY8's script has neither.
    }
    if (conductor.done) return "done";

    if (pendingTap !== null) {
      const option = pendingTap;
      const s = bindings.get("hero-s") ?? "";
      const card = [...cards.values()]
        .reverse()
        .find((c) => c.kind === "held" && c.attempt_ids.includes(s) && c.options.includes(option));
      if (card !== undefined) {
        tapN += 1;
        const answer = await step.do(`tap-${tapN}`, STEP_RETRY, () =>
          tapCard(env, pool, card, option, `${pool}-tap-${tapN}`),
        );
        if (answer.ok && !answer.stale) pendingTap = null;
      }
    }

    readN += 1;
    const read = await step.do(`read-${readN}`, STEP_RETRY, () => readEvents(env, pool, cursor));
    const since = (started ??= read.now);
    for (const event of read.events) {
      cursor = Math.max(cursor, event.n);
      if (event.type === "pool.paused" || event.type === "trunk.error") return "pool_failed";
      const card = event.card;
      if ((event.type === "card.opened" || event.type === "card.updated") && card !== undefined) {
        cards.delete(card.card_id); // re-insert: the newest card is last
        cards.set(card.card_id, card);
      }
      if (event.type === "card.closed" && typeof event.card_id === "string") cards.delete(event.card_id);
      conductor.observe(event);
    }
    if (read.now - since >= TRY_DEADLINE_MS) return "deadline";
  }
}
