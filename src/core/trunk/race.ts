// Race launch, candidate readiness and submit measurements (RC1-RC5, CD2, 9.8).
import type {
  RaceCostDone,
  RaceCostJob,
  TrunkCreateIntentRequest,
  TrunkCreateIntentResponse,
} from "../../protocol/internal.ts";
import { openAttempt, refreshCardText } from "./intents.ts";
import { event } from "./events.ts";
import { submitIdOf } from "./submit.ts";
import { blast } from "./landing.ts";
import { enqueuePreviews } from "./preview.ts";
import type { Attempt, CardRec, Pool } from "./sets.ts";

export function raceCostKey(job: Pick<RaceCostJob, "card_id" | "attempt_id">): string {
  return `race_cost:${JSON.stringify([job.card_id, job.attempt_id])}`;
}

export function queueRaceCost(pool: Pool, card: CardRec, attempt: Attempt): void {
  if (attempt.submit_id === null || attempt.submitted_at === null) return;
  const job: RaceCostJob = {
    epoch: Number(pool.meta.get("epoch") ?? "1"),
    card_id: card.card_id,
    attempt_id: attempt.id,
    submit_id: attempt.submit_id,
    submitted_at: attempt.submitted_at,
  };
  pool.meta.set(raceCostKey(job), JSON.stringify(job));
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('race_cost', '', ?)", pool.now());
}

/** A failed read is consumed too: unavailable cost stays null until a new submit. */
export function raceCostDone(pool: Pool, input: RaceCostDone): void {
  const key = raceCostKey(input);
  const raw = pool.meta.get(key);
  if (raw === undefined) return;
  const job = JSON.parse(raw) as RaceCostJob;
  if (job.epoch !== input.epoch || job.submit_id !== input.submit_id || job.submitted_at !== input.submitted_at) return;
  pool.meta.delete(key);
  pool.sql.exec("DELETE FROM meta WHERE k = ?", key);
  const card = pool.cards.find((c) => c.card_id === input.card_id && c.open && c.kind === "race");
  const attempt = pool.attempts.get(input.attempt_id);
  const candidate = card?.body.candidates?.[input.attempt_id];
  if (
    input.epoch !== Number(pool.meta.get("epoch") ?? "1") ||
    card === undefined ||
    candidate === undefined ||
    attempt?.state !== "held" ||
    attempt.submit_id !== input.submit_id ||
    attempt.submitted_at !== input.submitted_at ||
    card.body.submit_ids[input.attempt_id] !== input.submit_id ||
    input.cost_usd === null ||
    !Number.isFinite(input.cost_usd) ||
    input.cost_usd < 0 ||
    candidate.cost_usd === input.cost_usd
  )
    return;
  candidate.cost_usd = input.cost_usd;
  pool.dirtyCards.add(card.card_id);
  event(pool, "card.updated", { card: card.body });
}

/** RC3: elapsed whole seconds on the injected pool clock; old stores remain unknown. */
export function raceSeconds(pool: Pool, attempt: Attempt): number | null {
  const opened = pool.meta.get(`race_opened:${attempt.id}`);
  if (opened === undefined || attempt.submitted_at === null) return null;
  return Math.max(0, Math.floor((attempt.submitted_at - Number(opened)) / 1_000));
}

/** RC2/RC3: both a passing submit and T12's final triage answer use the same card. */
export function updateRaceSubmit(pool: Pool, attempt: Attempt): CardRec | undefined {
  const card = pool.cards.find((c) => c.open && c.kind === "race" && c.attempt_ids.includes(attempt.id));
  if (card === undefined || attempt.submit_id === null) return card;
  attempt.approved_by = null;
  card.body.candidates ??= {};
  card.body.candidates[attempt.id] = {
    state: "held",
    can_choose: true,
    seconds: raceSeconds(pool, attempt),
    cost_usd: null,
  };
  if (card.body.submit_ids[attempt.id] !== attempt.submit_id && card.body.preview !== null) {
    delete card.body.preview.after[attempt.id];
  }
  card.body.submit_ids[attempt.id] = attempt.submit_id;
  card.body.blast_radius[attempt.id] = blast(pool, attempt);
  queueRaceCost(pool, card, attempt);
  enqueuePreviews(pool, card);
  refreshCardText(pool, card);
  pool.dirtyCards.add(card.card_id);
  event(pool, "card.updated", { card: card.body });
  return card;
}

/** T13: reject an unavailable choice before any sibling is stopped. */
export function canChooseRace(pool: Pool, attempt: Attempt): boolean {
  const card = pool.cards.find((c) => c.open && c.kind === "race" && c.attempt_ids.includes(attempt.id));
  return (
    card !== undefined &&
    attempt.race &&
    attempt.state === "held" &&
    attempt.submit_id !== null &&
    card.body.submit_ids[attempt.id] === attempt.submit_id &&
    submitIdOf(attempt) === attempt.submit_id &&
    [...attempt.premises.values()].every((p) => p.status === "holds") &&
    attempt.heads.every((h) => h.resolved_at !== null)
  );
}

/** RC5/CD2: transitions and triage settle before the transaction publishes its final card. */
export function refreshRaceCandidates(pool: Pool): void {
  for (const card of pool.cards) {
    if (!card.open || card.kind !== "race") continue;
    let changed = false;
    for (const id of card.attempt_ids) {
      const attempt = pool.attempts.get(id);
      const candidate = card.body.candidates?.[id];
      if (attempt === undefined || candidate === undefined) continue;
      const ready = canChooseRace(pool, attempt);
      if (candidate.state === attempt.state && candidate.can_choose === ready) continue;
      candidate.state = attempt.state;
      candidate.can_choose = ready;
      changed = true;
    }
    if (changed) {
      refreshCardText(pool, card);
      pool.dirtyCards.add(card.card_id);
      event(pool, "card.updated", { card: card.body });
    }
    if (
      card.attempt_ids.every((id) => ["stopped", "accepted", "landed"].includes(pool.attempts.get(id)?.state ?? ""))
    ) {
      card.open = false;
      card.closed_at = pool.now();
      pool.dirtyCards.add(card.card_id);
      event(pool, "card.closed", {
        card_id: card.card_id,
        action: "superseded",
        by: "system",
        attempt_id: null,
        reason: null,
      });
    }
  }
}

export function createIntent(pool: Pool, request: TrunkCreateIntentRequest): TrunkCreateIntentResponse {
  const key = `intent_request:${request.request_id}`;
  const stored = pool.meta.get(key);
  if (stored !== undefined) return JSON.parse(stored) as TrunkCreateIntentResponse;
  if ((pool.meta.get("pool_state") ?? "ready") !== "ready") return { ok: false, error: "pool_not_ready" };
  const launches = request.candidates.map(({ attempt_id, model }) => {
    const attempt = openAttempt(pool, attempt_id, {
      intent_id: request.intent_id,
      intent: request.text,
      requester: "owner",
      race: request.race,
      prewritten: request.prewritten,
      agent_kind: "real",
      model,
    });
    return {
      pool: pool.meta.get("pool_id") ?? "",
      attempt_id,
      intent_id: attempt.intent_id,
      change_id: attempt.change_id,
      intent_text: request.text,
      requester: "owner",
      agent_kind: "real" as const,
      driver: "model" as const,
      model,
    };
  });
  const answer: TrunkCreateIntentResponse = { ok: true, intent_id: request.intent_id, launches };
  pool.meta.set(key, JSON.stringify(answer));
  return answer;
}
