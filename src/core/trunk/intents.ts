// src/core/trunk/intents.ts — intents, attempts and the shared state-transition helpers of
// 01-core.md 9.1/9.2: setState (emits attempt.state), unvalidate, the card helpers, and the
// attempt-class lists the tick uses (in-flight, parked, frozen).

import type { AttemptState } from "../../protocol/attempt.ts";
import type { Card, CardKind, CardReason } from "../../protocol/cards.ts";
import { CARD_TEMPLATES, type CardTemplateId } from "../../copy/cards.ts";
import type { Attempt, CardRec, IntentRec, Pool, Premise } from "./sets.ts";
import { event, emitPoolState } from "./events.ts";
import { RIGHT_OF_WAY_MS } from "../../protocol/constants.ts";

const WAITING: readonly AttemptState[] = ["submitted", "validated", "held"];
export const IN_FLIGHT: readonly AttemptState[] = [
  "working",
  "going_around",
  "needs_confirm",
  "submitted",
  "validated",
  "held",
];
export const isWaiting = (a: Attempt): boolean => WAITING.includes(a.state);
export const inflight = (pool: Pool): Attempt[] =>
  [...pool.attempts.values()].filter((a) => IN_FLIGHT.includes(a.state));
export const parked = (pool: Pool): Attempt[] =>
  [...pool.attempts.values()].filter(
    (a) => a.state === "stopped" && pool.cards.some((c) => c.open && c.kind === "choice" && c.attempt_ids[0] === a.id),
  );
/** A landing's frozen premise set, the shape QR4's `landers` reads (7.2), with the attempt that
 * holds it: for row QR4 the landed change decides the triage (TR8). */
export const frozen = (a: Attempt): { premises: Premise[]; attempt_id: string } => ({
  premises: [...a.premises.values()].map((p) => ({ ...p })),
  attempt_id: a.id,
});

/** `a.go_arounds + a.pull_backs` — the count that drives GO_AROUND_LIMIT and STARVATION_AFTER. */
export const sentBack = (a: Attempt): number => a.go_arounds + a.pull_backs;

/** RW1's grant: the mark is the engine clock's `now` in ms — never below another live mark, so
 * grant order survives a shared millisecond (RW4) — and the `right_of_way` timer row (3.3) is
 * the alarm's durable record of when the grant lapses. */
export function grantRightOfWay(pool: Pool, a: Attempt): void {
  if (a.right_of_way_at !== null) return;
  let at = pool.now();
  for (const x of pool.attempts.values()) {
    if (x.right_of_way_at !== null) at = Math.max(at, x.right_of_way_at + 1);
  }
  a.right_of_way_at = at;
  pool.sql.exec(
    "INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('right_of_way', ?, ?)",
    a.id,
    at + RIGHT_OF_WAY_MS,
  );
  pool.dirtyAttempts.add(a.id);
}

/** Every other end of RW1 — landing, stop, reopen (T19) or the timer — drops mark and row. */
export function clearRightOfWay(pool: Pool, a: Attempt): void {
  if (a.right_of_way_at === null) return;
  a.right_of_way_at = null;
  pool.sql.exec("DELETE FROM timers WHERE kind = 'right_of_way' AND key = ?", a.id);
  // The mark's end can unblock an RW3-skipped candidate: a stop or reopen outside a tick
  // leaves nothing armed otherwise, so the grant's end wakes the tick itself.
  scheduleTick(pool);
  pool.dirtyAttempts.add(a.id);
}

/** A live mark (RW1): granted less than RIGHT_OF_WAY_MS ago on the engine's clock. The tick
 * checks this so a grant whose timer row was lost still lapses on time. */
export function hasRightOfWay(pool: Pool, a: Attempt): boolean {
  return a.right_of_way_at !== null && a.right_of_way_at + RIGHT_OF_WAY_MS > pool.now();
}

/** A state transition (9.2): emits `attempt.state`, records `stop_reason` when given. */
export function setState(
  pool: Pool,
  a: Attempt,
  to: AttemptState,
  transition: string,
  reason: string | null = null,
): void {
  if (a.state !== to) {
    const from = a.state;
    a.state = to;
    // RW1: landing or stopping ends the grant — its timer row goes with it (AL1).
    if (to === "stopped" || to === "landed") clearRightOfWay(pool, a);
    event(pool, "attempt.state", {
      attempt_id: a.id,
      from,
      to,
      transition,
      reason,
      go_arounds: a.go_arounds,
      pull_backs: a.pull_backs,
      right_of_way: a.right_of_way_at !== null,
    });
  }
  if (reason !== null) a.stop_reason = reason;
  pool.dirtyAttempts.add(a.id);
  if (to === "validated" && a.state === to) scheduleTick(pool);
}

/** 9.4: the `tick` timer fires while any attempt is `validated` or any undo request is queued —
 * armed here at the transition, re-armed by the tick while work remains and by `push_ok` when the
 * outbox that blocked it clears. `delay` is 0 (fire at the next alarm) or TICK_MS (the cadence). */
export function scheduleTick(pool: Pool, delay = 0): void {
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('tick', '', ?)", pool.now() + delay);
}

/** Forget the queued submission (T22, pull-backs, repairs): the next submit recomputes it. */
export function unvalidate(pool: Pool, a: Attempt): void {
  a.submit_id = null;
  a.validated_at = null;
  a.approved_by = null;
  a.approved_at = null;
  a.approved_option = null;
  a.policy_risk = null;
  a.bypass_row = false;
  pool.dirtyAttempts.add(a.id);
}

/** Close the attempt's open non-choice card (T22, heads-up effects); emits `card.closed`. */
export function closeCard(pool: Pool, a: Attempt, action: string, by: "owner" | "system" = "system"): void {
  for (const c of pool.cards) {
    if (c.open && c.attempt_ids.includes(a.id) && c.kind === "race") {
      c.body.candidates ??= {};
      const cand = c.body.candidates[a.id];
      if (cand === undefined)
        c.body.candidates[a.id] = { state: a.state, can_choose: false, seconds: null, cost_usd: null };
      else {
        cand.state = a.state;
        cand.can_choose = false;
      }
      pool.dirtyCards.add(c.card_id);
      event(pool, "card.updated", { card: c.body });
      const inFlight = c.attempt_ids.some((id) => {
        const x = pool.attempts.get(id);
        return x !== undefined && !["stopped", "accepted", "landed"].includes(x.state);
      });
      if (!inFlight) {
        c.open = false;
        c.closed_at = pool.now();
        event(pool, "card.closed", {
          card_id: c.card_id,
          action: "superseded",
          by: "system",
          attempt_id: null,
          reason: null,
        });
      }
      continue;
    }
    if (c.open && c.attempt_ids.includes(a.id) && c.kind !== "choice") {
      c.open = false;
      c.closed_at = pool.now();
      pool.dirtyCards.add(c.card_id);
      event(pool, "card.closed", { card_id: c.card_id, action, by, attempt_id: null, reason: null });
    }
  }
  a.approved_by = null;
  a.approved_at = null;
  a.approved_option = null;
  a.policy_risk = null;
  pool.dirtyAttempts.add(a.id);
}

/** Open a card (10.3) and emit `card.opened`. Returns the record. */
export function openCard(
  pool: Pool,
  kind: CardKind,
  reason: CardReason,
  attempt_ids: string[],
  extra: { body?: Partial<Card>; blast_radius?: Card["blast_radius"]; submit_ids?: Record<string, string> } = {},
): CardRec {
  const card_id = `k_${String(pool.cardCounter++).padStart(4, "0")}`;
  // CD4: the options of the card, in the table's order. `land_now` joins the held card only on
  // the full form (features.held) while the case of 10.2 step 4 holds: the blast radius lists an
  // attempt with right of way under `repair` or `confirm`.
  const fullHeld = kind === "held" && pool.featuresHeld;
  const landNow =
    fullHeld &&
    Object.values(extra.blast_radius ?? {}).some((b) =>
      b.right_of_way.some((id) => b.repair.includes(id) || b.confirm.includes(id)),
    );
  const template = CARD_TEMPLATES[`${kind}:${reason}` as CardTemplateId];
  const options = (template?.options ?? [])
    .filter((o) => o.id !== "land_now" || landNow)
    .map((o) => ({ id: o.id, label: o.label }));
  const body: Card = {
    card_id,
    kind,
    attempt_ids,
    intent_ids: attempt_ids.map((id) => pool.attempts.get(id)?.intent_id ?? ""),
    submit_ids: extra.submit_ids ?? {},
    title: reason,
    body: [],
    options,
    paths: [],
    // HD1: on the minimal held form `card.opened` carries an empty blast radius; the callers
    // still compute it, because the `land_now` check of 10.2 step 4 reads it.
    blast_radius: kind === "held" && !pool.featuresHeld ? {} : (extra.blast_radius ?? {}),
    preview: null,
    candidates: null,
    risk: null,
    reason,
    ...(extra.body ?? {}),
  };
  const c: CardRec = {
    card_id,
    kind,
    open: true,
    body,
    created_at: pool.now(),
    closed_at: null,
    reason,
    attempt_ids,
    intent_ids: body.intent_ids,
  };
  pool.cards.push(c);
  pool.dirtyCards.add(card_id);
  pool.out.cards.push({ kind, reason, attempts: attempt_ids, blast_radius: body.blast_radius });
  event(pool, "card.opened", { card: body });
  return c;
}

/** Mark heads-ups `hn <= ack` as placed in the model's context (HU8). */
export function markDelivered(pool: Pool, a: Attempt, ack: number): void {
  if (ack > a.ack) a.ack = ack;
  for (const h of a.heads) {
    if (h.hn <= ack && h.delivered_at === null) {
      h.delivered_at = pool.now();
      // HU5: the carry of a tool or sync response is a second delivery path — a heads-up the
      // Agent's ack covers was received without the push and needs no re-push.
      if (h.received_at === null) h.received_at = pool.now();
      pool.dirtyAttempts.add(a.id);
    }
  }
  pool.dirtyAttempts.add(a.id);
}

export type OpenArgs = {
  intent: string;
  intent_id?: string;
  race?: boolean;
  agent_kind?: "real" | "synthetic";
  model?: string | null;
  truth?: string[] | null;
  requester?: string;
};

/** Set an intent's state and emit `intent.state` once per transition (12.1). */
export function setIntentState(pool: Pool, intent_id: string, state: IntentRec["state"]): void {
  const i = pool.intents.get(intent_id);
  if (i === undefined || i.state === state) return;
  i.state = state;
  pool.dirtyIntents.add(intent_id);
  event(pool, "intent.state", { intent_id, state });
}

/** Create the intent (if new) and the attempt in state `opened` (9.2 T1); emits the events. */
export function openAttempt(pool: Pool, id: string, args: OpenArgs): Attempt {
  // An `open_attempt` for an attempt the pool already holds returns it unchanged (the route's
  // retry is idempotent); nothing is emitted twice.
  const existing = pool.attempts.get(id);
  if (existing !== undefined) return existing;
  const intent_id = args.intent_id ?? `i_${id}`;
  if (!pool.intents.has(intent_id)) {
    pool.intents.set(intent_id, {
      intent_id,
      text: args.intent,
      requester: args.requester ?? "agent",
      race: args.race === true,
      state: "open",
      created_at: pool.now(),
    });
    pool.dirtyIntents.add(intent_id);
    event(pool, "intent.created", {
      intent_id,
      text: args.intent,
      requester: args.requester ?? "agent",
      race: args.race === true,
      prewritten: false,
    });
  }
  const a: Attempt = {
    id,
    intent_id,
    change_id: `c_${String(pool.attemptCounter++).padStart(6, "0")}`,
    agent_kind: args.agent_kind ?? "real",
    model: args.model ?? null,
    race: args.race === true,
    truth: args.truth ?? null,
    resumes: 0,
    state: "opened",
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    revision: 1,
    right_of_way_at: null,
    opened_seq: pool.headSeq(),
    submit_id: null,
    summary: null,
    tier: null,
    approved_by: null,
    approved_at: null,
    approved_option: null,
    policy_risk: null,
    bypass_row: false,
    submitted_at: null,
    validated_at: null,
    landed_seq: null,
    attempt_repo: null,
    model_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    last_call_id: null,
    last_response: null,
    ack: 0,
    next_hn: 1,
    updated_at: pool.now(),
    intentText: args.intent,
    requester: args.requester ?? "agent",
    opCount: 0,
    op_mark: null,
    premises: new Map(),
    ops: [],
    heads: [],
    resolved: new Set(),
    e1: new Set(),
    checks: null,
    opsFirstDone: false,
    pending: [],
    dirtyJudgments: new Set(),
  };
  pool.attempts.set(id, a);
  pool.dirtyAttempts.add(id);
  if (a.agent_kind === "synthetic" && pool.meta.get("synthetic") !== "1") {
    // EM1a: the synthetic flag changes once, when the first synthetic attempt opens.
    pool.meta.set("synthetic", "1");
    emitPoolState(pool);
  }
  event(pool, "attempt.opened", {
    attempt_id: id,
    intent_id,
    change_id: a.change_id,
    agent: a.agent_kind,
    model: a.model,
    race: a.race,
  });
  if (a.race) {
    // RC1: the intent's single race card is open before any candidate runs.
    const card = pool.cards.find((c) => c.open && c.kind === "race" && c.intent_ids.includes(intent_id));
    const cand = { state: "opened" as const, can_choose: false, seconds: null, cost_usd: null };
    if (card === undefined) {
      openCard(pool, "race", "race", [id], { body: { candidates: { [id]: cand } } });
    } else {
      card.attempt_ids.push(id);
      card.body.candidates ??= {};
      card.body.candidates[id] = cand;
      pool.dirtyCards.add(card.card_id);
      event(pool, "card.updated", { card: card.body });
    }
  }
  return a;
}
