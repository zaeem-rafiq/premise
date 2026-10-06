// UN4/UN5: the owner-visible plan and its durable confirmation. No remote reads.
import type { UndoPlanResponse, UndoResponse } from "../../protocol/undo.ts";
import type { UndoRequest } from "../../protocol/routes.ts";
import { UNDO_WINDOW } from "../../protocol/constants.ts";
import type { Attempt, FileMap, Pool } from "./sets.ts";
import { inflight, scheduleTick } from "./intents.ts";
import { classify } from "../classify/table.ts";
import { worst } from "./landing.ts";
import { syncTriageOf, triageInputOf, triageOutcome } from "../classify/triage.ts";
import { event } from "./events.ts";
import { planUndo } from "../undo/plan.ts";

/** UN4 includes deterministic triage repairs. A remote triage answer is not yet known. */
function wouldRepair(pool: Pool, a: Attempt, after: FileMap): boolean {
  const classification = classify(pool, a, pool.files, after, null, []);
  if (worst(classification) === "repair") return true;
  const sync = syncTriageOf(pool, a);
  if (sync === null) return false;
  const items = classification.items.filter((i) => i.result === "triage" && i.folded !== true);
  if (items.length === 0) return false;
  const answer = sync.judgeNow(triageInputOf({ ...pool, files: after }, a, a, items, null));
  return items.some((i) => triageOutcome(pool, answer.answers[`${i.kind}:${i.key}`] ?? null).result === "repair");
}

export function undoPlan(pool: Pool, seq: number): UndoPlanResponse {
  const target = pool.landings.find((l) => l.seq === seq);
  if (target === undefined || target.kind !== "change") return { ok: false, reason: "not_a_change" };
  if (target.undone_by !== null) return { ok: false, reason: "already_undone" };
  if (pool.headSeq() - seq >= UNDO_WINDOW) return { ok: false, reason: "too_old" };
  const computed = planUndo(pool, seq, pool.files);
  if (computed.reverted.length > pool.K.MAX_BATCH) return { ok: false, reason: "too_many" };
  return {
    ok: true,
    plan: {
      target_seq: seq,
      reverted: computed.reverted,
      reopened: computed.reverted
        .filter((s) => s !== seq)
        .flatMap((s) => {
          const id = pool.landings.find((l) => l.seq === s)?.attempt_id;
          return id == null ? [] : [id];
        }),
      kept_readers: computed.kept,
      repairs: inflight(pool)
        .filter((a) => wouldRepair(pool, a, computed.files))
        .map((a) => a.id),
    },
  };
}

export function confirmUndo(pool: Pool, request: UndoRequest): UndoResponse {
  const responseKey = `undo_response:${request.request_id}`;
  const previous = pool.meta.get(responseKey);
  if (previous !== undefined) return JSON.parse(previous) as UndoResponse;
  // Queued requests written by older builds still have their idempotency identity.
  if (pool.undoLog.has(request.request_id)) return { ok: true, request_id: request.request_id };
  const current = undoPlan(pool, request.seq);
  let response: UndoResponse;
  if (!current.ok) response = current;
  else if (JSON.stringify(request.expect_reverted) !== JSON.stringify(current.plan.reverted)) {
    response = { ok: false, reason: "plan_changed", plan: current.plan };
  } else if (
    pool.undoQueue.some((q) =>
      (q.reverted ?? planUndo(pool, q.target_seq, pool.files).reverted).some((s) => current.plan.reverted.includes(s)),
    )
  ) {
    // A confirmed take-back already owns these landings until the next tick.
    response = { ok: false, reason: "already_undone" };
  } else {
    const queued = {
      request_id: request.request_id,
      target_seq: request.seq,
      cause: "undo" as const,
      state: "queued" as const,
      requested_by: "owner",
      reverted: current.plan.reverted,
    };
    pool.undoQueue.push(queued);
    pool.undoLog.set(request.request_id, queued);
    pool.dirtyUndo.add(request.request_id);
    scheduleTick(pool);
    event(pool, "undo.planned", { request_id: request.request_id, cause: "undo", ...current.plan });
    response = { ok: true, request_id: request.request_id };
  }
  if (!response.ok)
    event(pool, "undo.refused", { request_id: request.request_id, target_seq: request.seq, reason: response.reason });
  pool.meta.set(responseKey, JSON.stringify(response));
  return response;
}
