// T19/T19s and UN8: restore a landed attempt, or park it until the owner retries.
import { MAX_REVISIONS } from "../../protocol/constants.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import type { UndoComputation } from "../undo/plan.ts";
import type { Attempt, FileMap, Landing, Pool, ClassifyItem } from "./sets.ts";
import { entityAt, keyHash, sourceOf } from "./sets.ts";
import { clearRightOfWay, openCard, setIntentState, setState, unvalidate } from "./intents.ts";
import { event } from "./events.ts";
import { applyClassification, hItem } from "./landing.ts";
import { classify } from "../classify/table.ts";
import type { CauseSeq } from "./cause-seq.ts";

export type Reopened = {
  a: Attempt;
  x: Landing;
  plan: UndoComputation;
  cause: "undo" | "revert";
  undoSeq: number;
  head: FileMap;
};

export function reopen(pool: Pool, a: Attempt, landing: Landing, head: FileMap, cause: "undo" | "revert"): void {
  clearRightOfWay(pool, a);
  unvalidate(pool, a);
  a.ops = landing.ops.map((o) => ({
    ...o,
    dropped: false,
    ...(o.op === "write" ? { base_oid: head.has(o.path) ? blobId(utf8(head.get(o.path)!)) : "absent" } : {}),
  }));
  a.opCount = Math.max(0, ...a.ops.map((o) => o.op_seq));
  a.premises = new Map(
    landing.premises.map((p) => [`${p.kind}|${p.key}`, { ...p, status: "holds" as const, shown: null }]),
  );
  if (a.revision >= MAX_REVISIONS) {
    setState(pool, a, "stopped", "T19s", "revert_limit");
    openCard(pool, "choice", "revert_limit", [a.id]);
    setIntentState(pool, a.intent_id, "stopped");
  } else {
    a.revision += 1;
    a.go_arounds += 1;
    a.resumes += 1;
    a.stop_reason = null;
    a.opsFirstDone = false;
    pool.meta.set(`resume_cause:${a.id}`, cause);
    setState(pool, a, "going_around", "T19");
    setIntentState(pool, a.intent_id, "open");
    event(pool, "attempt.reopened", { attempt_id: a.id, cause, revision: a.revision, model_changed: false });
  }
  pool.dirtyAttempts.add(a.id);
}

export function repairReopened(
  pool: Pool,
  r: Reopened,
  head: FileMap,
  seq: number,
  batch: Landing[],
  causeSeq: CauseSeq,
): void {
  const items: ReturnType<typeof hItem>[] = [];
  for (const p of r.a.premises.values()) {
    const cur = keyHash(head, p.kind, p.key, pool.languages);
    const dep = r.plan.depKeys.get(r.x.seq)?.has(`${p.kind}|${p.key}`) === true;
    if (dep && cur.hash !== p.hash) {
      const it: ClassifyItem = {
        p,
        kind: p.kind,
        key: p.key,
        old_hash: p.hash,
        new_hash: cur.hash,
        members: cur.members,
        oldMembers: p.members,
        before: pool.fileMapAt(r.x.seq),
        after: head,
        after_src:
          p.kind === "entity" && entityAt(head, p.key, pool.languages) !== null
            ? sourceOf(head, p.key, pool.languages)
            : null,
        rule: p.kind === "file" ? "F1" : p.edit ? "E1" : "E2",
        result: "repair",
        reason: "reopened_dep_changed",
      };
      p.status = "pending_repair";
      items.push(hItem(pool, r.a, it, "repair", causeSeq(p.kind, p.key)));
    }
    // UN8 pins at the undo's head. Non-dependent facts may change again later in
    // this batch and still need ordinary classification before reaching its head.
    const pinned = dep ? cur : keyHash(r.head, p.kind, p.key, pool.languages);
    p.hash = pinned.hash;
    p.members = pinned.members;
    p.seq = r.undoSeq;
    p.shown = null;
  }
  // UN3 can reopen an attempt because its operations no longer replay. OP6 still
  // drops those operations, including on parked attempts (GL3a).
  const later = batch.filter((l) => l.seq > r.undoSeq);
  const classification = classify(
    pool,
    r.a,
    r.head,
    head,
    null,
    later.filter((l) => l.attempt_id !== null).map((l) => ({ premises: l.premises, attempt_id: l.attempt_id! })),
  );
  applyClassification(
    pool,
    r.a,
    classification,
    head,
    seq,
    {
      type: r.cause,
      seqs: [r.undoSeq, ...later.map((l) => l.seq)],
      changes: later
        .filter((l) => l.kind === "change")
        .map((l) => ({ seq: l.seq, change_id: l.change_id, intent_text: l.intentText })),
    },
    null,
    items,
    causeSeq,
  );
  for (const p of r.a.premises.values()) {
    p.seq = seq;
    p.shown = null;
  }
  pool.dirtyAttempts.add(r.a.id);
}
