// src/core/trunk/risk.ts — the engine side of the Clef risk questions on a held card (01-core
// 10.4, RK1, RK3, TR10's pattern): a held card that opens while `CLEF_RISK` is on queues its
// submit; the Worker's dispatch takes the queue with the 10.4 `state` of each change; the answer
// fills `Card.risk` and the card is updated (`card.updated`). The answers never land or decline
// a change (RK1). An answer for a card that closed, or for an older submit, is discarded.
// Pure and synchronous: the Clef call is the Worker's.

import { CLEF_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { RiskAnswers } from "../../protocol/cards.ts";
import type { RiskInput } from "../../protocol/ports.ts";
import { event, metaWrite, poolPolicy } from "./events.ts";
import { refreshCardText } from "./intents.ts";
import type { CardRec, Pool } from "./sets.ts";
import { curOps, entityKeysOf, isModule, replayOps, sourceOf } from "./sets.ts";

const PENDING_KEY = "risk_pending";

type Entry = { card_id: string; attempt_id: string; dispatched_at: number | null; deadline_at: number | null };

/** One risk request the Worker sends through the `RiskJudge` port. */
export type RiskRequest = { submit_id: string; attempt_id: string; card_id: string; input: RiskInput };

function pending(pool: Pool): Record<string, Entry> {
  const raw = pool.meta.get(PENDING_KEY);
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, Entry>);
}

function save(pool: Pool, map: Record<string, Entry>): void {
  const entries = Object.values(map);
  metaWrite(pool, PENDING_KEY, entries.length === 0 ? null : JSON.stringify(map));
  const deadlines = entries.map((e) => e.deadline_at ?? pool.now() + CLEF_TIMEOUT_MS);
  if (deadlines.length === 0) pool.sql.exec("DELETE FROM timers WHERE kind = 'risk' AND key = ''");
  else
    pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('risk', '', ?)", Math.min(...deadlines));
}

/** RK1: a full held card (HD1's minimal form shows no risk) asks once per submit when `CLEF_RISK` is on. */
export function enqueueRisk(pool: Pool, c: CardRec): void {
  if (!pool.riskOn || c.kind !== "held" || !pool.featuresHeld) return;
  const map = pending(pool);
  for (const [attempt_id, submit_id] of Object.entries(c.body.submit_ids)) {
    map[submit_id] ??= { card_id: c.card_id, attempt_id, dispatched_at: null, deadline_at: null };
  }
  save(pool, map);
}

/** The `state` of 10.4 for one attempt's change: its intent and summary, the held paths of the
 * policy, and each touched file with its tier and the entities whose source changed. A file
 * with no entities (not a module, or opaque) is one item keyed by its path, with its whole text. */
export function riskInputOf(pool: Pool, c: CardRec, attempt_id: string): RiskInput | null {
  const a = pool.attempts.get(attempt_id);
  if (a === undefined) return null;
  const policy = poolPolicy(pool, pool.files);
  const view = replayOps(curOps(a), pool.files, {}, pool.languages).files;
  const files: RiskInput["files"] = c.body.paths.map(({ path, tier }) => {
    const before = pool.files.get(path);
    const after = view.get(path);
    const keysBefore =
      before !== undefined && isModule(path, pool.languages) ? entityKeysOf(pool.files, path, pool.languages) : null;
    const keysAfter =
      after !== undefined && isModule(path, pool.languages) ? entityKeysOf(view, path, pool.languages) : null;
    if (keysBefore === null && keysAfter === null) {
      return { path, tier, entities: [{ key: path, before: before ?? "", after: after ?? "" }] };
    }
    const keys = [...new Set([...(keysBefore ?? []), ...(keysAfter ?? [])])];
    const entities = keys
      .map((key) => ({
        key,
        before: sourceOf(pool.files, key, pool.languages) ?? "",
        after: sourceOf(view, key, pool.languages) ?? "",
      }))
      .filter((e) => e.before !== e.after);
    return { path, tier, entities };
  });
  return {
    intent: pool.intents.get(a.intent_id)?.text ?? "",
    summary: a.summary ?? "",
    held_paths: policy.tiers.filter((t) => t.tier === "held").flatMap((t) => t.paths),
    files,
  };
}

/** The open card an entry is about, while its submit is still the card's. */
function cardOf(pool: Pool, submit_id: string, e: Entry): CardRec | null {
  const c = pool.cards.find((x) => x.card_id === e.card_id);
  return c !== undefined && c.open && c.body.submit_ids[e.attempt_id] === submit_id ? c : null;
}

/** Fill the card's risk block (RK1) or its error (RK3) and update the card (CD2). */
function fill(pool: Pool, c: CardRec, risk: RiskAnswers): void {
  c.body.risk = risk;
  refreshCardText(pool, c);
  pool.dirtyCards.add(c.card_id);
  event(pool, "card.updated", { card: c.body });
}

/** The Worker's dispatch: every queued submit not sent yet, with its 10.4 state. */
export function dispatchRisk(pool: Pool): RiskRequest[] {
  const map = pending(pool);
  const out: RiskRequest[] = [];
  for (const [submit_id, e] of Object.entries(map)) {
    const c = cardOf(pool, submit_id, e);
    if (c === null) {
      delete map[submit_id];
      continue;
    }
    if (e.dispatched_at !== null) continue;
    const input = riskInputOf(pool, c, e.attempt_id);
    if (input === null) {
      delete map[submit_id];
      continue;
    }
    e.dispatched_at = pool.now();
    e.deadline_at = pool.now() + CLEF_TIMEOUT_MS;
    out.push({ submit_id, attempt_id: e.attempt_id, card_id: c.card_id, input });
  }
  save(pool, map);
  return out;
}

/** An answer for `submit_id`: fills its card while the card is open and about that submit. */
export function answerRisk(pool: Pool, submit_id: string, risk: RiskAnswers): void {
  const map = pending(pool);
  const e = map[submit_id];
  if (e === undefined) return;
  delete map[submit_id];
  const c = cardOf(pool, submit_id, e);
  if (c !== null) fill(pool, c, risk);
  save(pool, map);
}

/** The `risk` timer (TR6's rule for the risk questions): a question past its deadline, or one an
 * earlier instance sent (`restart`), is unavailable — RK3's error code `timeout`. */
export function overdueRisk(pool: Pool, restart = false): void {
  const map = pending(pool);
  for (const [submit_id, e] of Object.entries(map)) {
    const late = e.deadline_at !== null && (restart || e.deadline_at <= pool.now());
    if (!late) continue;
    delete map[submit_id];
    const c = cardOf(pool, submit_id, e);
    if (c !== null) {
      fill(pool, c, {
        model: "clef",
        does_what_asked: null,
        changes_shared_meaning: null,
        unrelated_edits: null,
        error: "timeout",
      });
    }
  }
  save(pool, map);
}
