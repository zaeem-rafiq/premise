// src/core/classify/triage.ts — the synchronous triage of S6/S6a: `OffTriage` (TR5), the
// per-attempt pick between it, the caller's `SyncTriage` port (`ScriptedTriage` for a
// synthetic attempt) and the asynchronous Clef `Triage`, the 7.3 outcome table, and the
// `TriageInput` builder the port answers. Pure: no promise, no clock, no Clef call.

import type { SyncTriage, TriageAnswers, TriageInput } from "../../protocol/ports.ts";
import type { Attempt, ClassifyItem, Pool } from "../trunk/sets.ts";
import { curOps, entityKeysOf, replayOps, sourceOf } from "../trunk/sets.ts";

/**
 * `OffTriage` (S6a, TR5): the `SyncTriage` whose every answer is `null` — unavailable — which
 * the 7.3 table maps to `confirm` with reason `triage_unavailable`. It stands in whenever
 * triage is known to be unavailable at classification time: `CLEF_TRIAGE = off` or the kill
 * switch set. It is also the fallback for a synthetic attempt whose pool was created without
 * a `SyncTriage` port.
 */
export const OffTriage: SyncTriage = {
  judgeNow(input: TriageInput): TriageAnswers {
    const answers: Record<string, number | null> = {};
    for (const question of Object.keys(input.premises)) answers[question] = null;
    return { answers, model: "off" };
  },
};

/**
 * The synchronous triage of an attempt (S6a): `pool.syncTriage` — the port the caller wires to
 * `ScriptedTriage` — for a synthetic attempt (TR8); `OffTriage` while `CLEF_TRIAGE` is off or
 * the kill switch is set (TR5); `null` otherwise, which sends the premise to the asynchronous
 * Clef `Triage` of TR2.
 */
export function syncTriageOf(pool: Pool, a: Attempt): SyncTriage | null {
  if (a.agent_kind === "synthetic") return pool.syncTriage ?? OffTriage;
  if (!pool.clefOn || pool.killed) return OffTriage;
  return null;
}

/** The 7.3 outcome table: an answer's probability maps to the judgment's result and reason. */
export function triageOutcome(
  pool: Pool,
  p: number | null,
): { result: "holds" | "confirm" | "repair"; reason: string } {
  if (p === null) return { result: "confirm", reason: "triage_unavailable" };
  if (p >= pool.K.T_REPAIR) return { result: "repair", reason: "triage_depends" };
  if (p >= pool.K.T_CONFIRM) return { result: "confirm", reason: "triage_unsure" };
  return { result: "holds", reason: "reaffirmed" };
}

/**
 * The `TriageInput` of S6 for one deciding attempt's batch of triage items. `intent`, `patch`
 * and `truth` are the decider's — for QR4 the landed change's, for the other rows the
 * attempt's own (TR8, the swapped roles of 7.3's question text). The premises map is keyed by
 * `<kind>:<key>`.
 */
export function triageInputOf(
  pool: Pool,
  a: Attempt,
  decider: Attempt,
  items: ClassifyItem[],
  causeAttempt: Attempt | null,
): TriageInput {
  const view = replayOps(curOps(decider), pool.files);
  const patch: Array<{ key: string; source: string }> = [];
  for (const path of view.files.keys()) {
    for (const key of entityKeysOf(view.files, path) ?? []) {
      const source = sourceOf(view.files, key);
      // added and altered entities of the decider's view: absent or different at head.
      if (source !== null && source !== sourceOf(pool.files, key)) patch.push({ key, source });
    }
  }
  const intentOf = (x: Attempt): string => pool.intents.get(x.intent_id)?.text ?? "";
  const premises: TriageInput["premises"] = {};
  for (const it of items) {
    const p = it.p;
    const qr4 = it.rule === "QR4";
    premises[`${p.kind}:${p.key}`] = {
      kind: p.kind,
      key: p.key,
      rule: it.rule ?? "",
      read_then:
        p.kind === "entity"
          ? sourceOf(it.before, p.key)
          : p.kind === "file"
            ? (it.before.get(p.key) ?? null)
            : JSON.stringify(it.oldMembers ?? []),
      is_now:
        p.kind === "entity"
          ? (it.after_src ?? sourceOf(it.after, p.key))
          : p.kind === "file"
            ? (it.after.get(p.key) ?? null)
            : JSON.stringify(it.members ?? []),
      changed_by_intent: qr4 ? intentOf(a) : causeAttempt === null ? null : intentOf(causeAttempt),
      ...(it.added !== undefined && it.added.length > 0
        ? { added: it.added.map((key) => ({ key, source: sourceOf(it.after, key) })) }
        : {}),
      changed: p.kind === "file" ? (it.changed ?? []) : [],
    };
  }
  return { attempt_id: decider.id, intent: intentOf(decider), patch, premises, truth: decider.truth };
}
