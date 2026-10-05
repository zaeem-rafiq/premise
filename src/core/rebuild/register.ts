// src/core/rebuild/register.ts — the `register` engine entry (01-core 3.6 steps 6 to 8, T17/T17a).
// After a rebuild an Agent's Trunk row is gone: its next `register` re-creates the attempt, replays
// the ops and read-premises it mirrors, and re-classifies the result under the normal rules — with
// `before_unavailable: true` on entity diffs, because the pinned text no longer exists anywhere.

import type { RegisterRequest, RegisterResponse } from "../../protocol/tools.ts";
import type { Attempt, Pool, Premise } from "../trunk/sets.ts";
import { classify } from "../classify/table.ts";
import { applyClassification, emitSent, pushHeadsUp } from "../trunk/landing.ts";
import { closeCard, grantRightOfWay, setState } from "../trunk/intents.ts";
import { pid, syncPremises } from "../trunk/premises.ts";
import { headsUpsFor } from "../trunk/tools-edit.ts";
import { event } from "../trunk/events.ts";
import { metaSet } from "../trunk/schema.ts";
import type { ExpectedRegister } from "./plan.ts";
import { parseNote } from "./plan.ts";

function closed(state: string): boolean {
  return state === "landed" || state === "stopped" || state === "accepted";
}

/**
 * The Agent's `register` call (4.12). While `rebuilding` nothing registers (pool_not_ready). A
 * known non-terminal attempt answers its pending heads-ups; a terminal one is `attempt_closed`.
 * An unknown attempt is re-created only while `register_expect` names it — a pool that has not
 * just rebuilt answers `invalid_args`, which closes a dead Agent on a live pool.
 */
export function register(pool: Pool, req: RegisterRequest): RegisterResponse {
  if ((pool.meta.get("pool_state") ?? "ready") === "rebuilding") {
    return { ok: false, error: "pool_not_ready" };
  }
  const existing = pool.attempts.get(req.attempt_id);
  if (existing !== undefined) {
    if (closed(existing.state)) return { ok: false, error: "attempt_closed" };
    const { heads_ups } = headsUpsFor(existing, existing.ack);
    return {
      ok: true,
      heads_ups,
      attempt: {
        state: existing.state,
        go_arounds: existing.go_arounds,
        pull_backs: existing.pull_backs,
      },
    };
  }
  const exp = expectedOf(pool).find((e) => e.attempt_id === req.attempt_id);
  if (exp === undefined) return { ok: false, error: "invalid_args" };

  // T17a: the attempt was `accepted` and the rebuilt main already carries its change at the same
  // revision — the landing stands; the attempt row is landed and the Agent closes.
  if (exp.state === "accepted") {
    const landing = pool.landings.find((l) => l.change_id === req.change_id);
    const note = landing === undefined || landing.note === "" ? null : parseNote(landing.note);
    if (landing !== undefined && note !== null && note.revision === req.revision) {
      const a = recreate(pool, exp, req);
      a.landed_seq = landing.seq;
      a.state = "accepted";
      setState(pool, a, "landed", "T17a");
      return { ok: false, error: "attempt_closed" };
    }
    // T17: the landing it named never reached the remote — repair, counted as a go-around.
    const a = recreate(pool, exp, req);
    a.state = "accepted";
    const cause = { type: "landing" as const, seqs: [], changes: [] };
    const item = {
      item: {
        premise: { kind: "check" as const, key: a.change_id },
        rule: "L1",
        result: "repair" as const,
        reason: "push_lost",
        old_hash: "",
        new_hash: "",
        cause_seq: null,
        diff: { kind: "check" as const, check: a.change_id, code: "push_lost" },
        uses: [],
      },
      trace: { kind: "check", key: a.change_id, rule: "L1", result: "repair", reason: "push_lost" },
    };
    const j = pool.newJudgment(a, {
      kind: "check",
      key: a.change_id,
      old_hash: "",
      new_hash: "",
      cause: "landing",
      cause_seq: null,
      rule: "L1",
      klass: "rule",
      result: "repair",
      reason: "push_lost",
    });
    j.dirty = true;
    pool.out.judgments.push(j);
    const h = pushHeadsUp(pool, a, "repair", [item], [], cause);
    closeCard(pool, a, "stale");
    const sentBack = a.go_arounds + a.pull_backs;
    if (sentBack + 1 >= pool.K.GO_AROUND_LIMIT) {
      h.body.go_around = a.go_arounds;
      emitSent(pool, a, h, [item]);
      setState(pool, a, "stopped", "T9", "go_around_limit");
    } else {
      a.go_arounds += 1;
      a.op_mark = a.opCount;
      if (sentBack + 1 === pool.K.STARVATION_AFTER) grantRightOfWay(pool, a);
      h.body.go_around = a.go_arounds;
      emitSent(pool, a, h, [item]);
      setState(pool, a, "going_around", "T17");
    }
    const { heads_ups } = headsUpsFor(a, a.ack);
    return {
      ok: true,
      heads_ups,
      attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
    };
  }

  // Step 6: the attempt re-opens; ops and read-premises are stored, edit/derived premises are
  // recomputed (syncPremises) and every read premise is classified against the rebuilt head.
  const a = recreate(pool, exp, req);
  for (const o of req.ops) a.ops.push({ ...o, dropped: false });
  a.opCount = a.ops.length;
  for (const p of req.read_premises) {
    a.premises.set(pid(p.kind, p.key), {
      kind: p.kind,
      key: p.key,
      hash: p.hash,
      seq: p.seq,
      members: null,
      shown: null, // step 6: shown is empty, so a whole-file write needs a new read (W1)
      read: true,
      edit: false,
      derived: false,
      status: "holds",
    });
  }
  if (req.truth !== undefined && req.truth !== null) a.truth = req.truth;
  setState(pool, a, "working", "T1");
  syncPremises(pool, a);
  const c = classify(pool, a, new Map(), pool.files, null, []);
  applyClassification(pool, a, c, pool.files, pool.headSeq(), { type: "landing", seqs: [], changes: [] }, null);
  const { heads_ups } = headsUpsFor(a, a.ack);
  return {
    ok: true,
    heads_ups,
    attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
  };
}

function expectedOf(pool: Pool): ExpectedRegister[] {
  const raw = pool.meta.get("register_expect");
  if (raw === undefined || raw === "") return [];
  try {
    return JSON.parse(raw) as ExpectedRegister[];
  } catch {
    return [];
  }
}

/** The re-created row: identity from the request, caught-up fields from the startRebuild capture. */
function recreate(pool: Pool, exp: ExpectedRegister, req: RegisterRequest): Attempt {
  const now = pool.now();
  if (!pool.intents.has(req.intent_id)) {
    pool.intents.set(req.intent_id, {
      intent_id: req.intent_id,
      text: exp.intent_text ?? "",
      requester: exp.requester ?? "agent",
      race: false,
      state: "open",
      created_at: now,
    });
    pool.dirtyIntents.add(req.intent_id);
    event(pool, "intent.created", {
      intent_id: req.intent_id,
      text: exp.intent_text ?? "",
      requester: exp.requester ?? "agent",
      race: false,
      attempt_id: req.attempt_id,
      race_of: null,
      intents: [],
    });
  }
  const a: Attempt = {
    id: req.attempt_id,
    intent_id: req.intent_id,
    change_id: req.change_id === "" ? `c_${String(pool.attemptCounter++).padStart(6, "0")}` : req.change_id,
    agent_kind: req.agent_kind,
    model: req.model,
    race: false,
    truth: req.truth ?? null,
    resumes: 0,
    state: "opened",
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    revision: req.revision,
    right_of_way_at: null,
    opened_seq: exp.opened_seq ?? 0,
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
    updated_at: now,
    intentText: exp.intent_text ?? "",
    requester: exp.requester ?? "agent",
    opCount: 0,
    op_mark: null,
    premises: new Map<string, Premise>(),
    ops: [],
    heads: [],
    resolved: new Set(),
    e1: new Set(),
    checks: null,
    opsFirstDone: false,
    pending: [],
    dirtyJudgments: new Set(),
  };
  pool.attempts.set(a.id, a);
  pool.dirtyAttempts.add(a.id);
  if (a.agent_kind === "synthetic") pool.meta.set("synthetic", "1");
  event(pool, "attempt.opened", {
    attempt_id: a.id,
    intent_id: a.intent_id,
    change_id: a.change_id,
    agent: a.agent_kind,
    model: a.model,
    race: a.race,
  });
  return a;
}
