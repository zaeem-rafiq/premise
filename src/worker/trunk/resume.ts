// The resume delivery of RS1 and the T20r fallback of RS4 (01-core 8.3, 9.2, 10.3): a T19 or
// T21 transaction adds 1 to `attempts.resumes` and emits `attempt.reopened`; after the commit
// the shell owes the attempt's Agent Durable Object a `resume` call — sent at once, repeated
// every HEADS_UP_REPUSH_MS until the Agent answers, for at most RESUME_ACK_TIMEOUT_MS from
// the first send. An `ok: false`, or silence at the deadline, stops the attempt
// `reopen_failed` and opens the choice card of UN6 — T20r — unless the attempt took a step
// of its own meanwhile (T20r's "took no step" guard, read on `last_call_id`).
//
// The engine has no T20r entry: the transition, its card.opened and the deletion of the
// attempt's premises and operations are the shell's work, in one transaction.

import { HEADS_UP_REPUSH_MS, RESUME_ACK_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { ResumeRequest, ResumeResponse } from "../../protocol/tools.ts";
import type { Card } from "../../protocol/cards.ts";
import type { AttemptState } from "../../protocol/attempt.ts";
import type { Sql } from "../../protocol/ports.ts";
import { CARD_TEMPLATES } from "../../copy/cards.ts";
import { fill } from "../../copy/fill.ts";
import { changeName } from "../../copy/names.ts";
import type { Env } from "../env.ts";
import {
  appendEvent,
  metaDelete,
  metaGet,
  metaSet,
  pendingEvents,
  sqlOf,
  timerDelete,
  timerGetDue,
  timerPut,
} from "./sql.ts";

/** The attempt states a resume cycle can start and finish in (T19, T21, T20r's source states). */
const REOPEN_STATES = new Set(["working", "going_around", "needs_confirm"]);

const CYCLE = "resume_cycle:";
const DONE = "resume_done:";
const RESUME_URL = "https://agent/resume";

/** The cycle a `resume` owes, stored in `meta` so it survives an evicted object (LP6's shape). */
type ResumeCycle = {
  resume_n: number;
  revision: number;
  cause: "retry" | "undo" | "revert";
  /** First send + RESUME_ACK_TIMEOUT_MS (RS1's "at most"). */
  deadline: number;
  /** The next send's due time — the HEADS_UP_REPUSH_MS cadence (RS1). */
  next_send: number;
  /** `attempts.last_call_id` at detection — T20r's "the attempt took no step" guard. */
  since_call: string | null;
};

type AttemptRow = {
  attempt_id: string;
  intent_id: string;
  resumes: number;
  revision: number;
  state: string;
  last_call_id: string | null;
  go_arounds: number;
  pull_backs: number;
  right_of_way_at: number | null;
};

function attempts(sql: Sql): AttemptRow[] {
  return sql
    .exec(
      `SELECT attempt_id, intent_id, resumes, revision, state, last_call_id, go_arounds,
              pull_backs, right_of_way_at
       FROM attempts WHERE resumes > 0`,
    )
    .toArray()
    .map((row) => ({
      attempt_id: String(row.attempt_id),
      intent_id: String(row.intent_id),
      resumes: Number(row.resumes),
      revision: Number(row.revision),
      state: String(row.state),
      last_call_id: row.last_call_id === null || row.last_call_id === undefined ? null : String(row.last_call_id),
      go_arounds: Number(row.go_arounds),
      pull_backs: Number(row.pull_backs),
      right_of_way_at:
        row.right_of_way_at === null || row.right_of_way_at === undefined ? null : Number(row.right_of_way_at),
    }));
}

function cycleOf(sql: Sql, attempt_id: string): ResumeCycle | null {
  const raw = metaGet(sql, `${CYCLE}${attempt_id}`);
  if (raw === null) return null;
  return JSON.parse(raw) as ResumeCycle;
}

function endCycle(sql: Sql, attempt_id: string, resume_n: number): void {
  sql.transaction(() => {
    metaSet(sql, `${DONE}${attempt_id}`, resume_n);
    metaDelete(sql, `${CYCLE}${attempt_id}`);
    timerDelete(sql, "resume", attempt_id);
  });
}

/** The `cause` of the attempt's newest `attempt.reopened` in the still-pending events — `retry`
 * when none is there (already confirmed, or emitted before the shell watched). */
function causeOf(sql: Sql, attempt_id: string): ResumeCycle["cause"] {
  let cause: ResumeCycle["cause"] = "retry";
  for (const row of pendingEvents(sql)) {
    const body = JSON.parse(row.body) as { type?: string; attempt_id?: string; cause?: string };
    if (body.type === "attempt.reopened" && body.attempt_id === attempt_id) {
      if (body.cause === "undo" || body.cause === "revert" || body.cause === "retry") cause = body.cause;
    }
  }
  return cause;
}

/**
 * T20r, in one transaction: `stopped` with reason `reopen_failed`, the `attempt.state` event of
 * the transition table, the attempt's open non-choice card closed `stale`, its premises and
 * operations deleted (it is not parked), and the choice card of UN6 opened with the options
 * `new_attempt` and `stop`.
 */
function applyReopenFailed(ctx: DurableObjectState, a: AttemptRow, now: number): void {
  const sql = sqlOf(ctx);
  const pool = ctx.id.name ?? "";
  sql.transaction(() => {
    // closeCard (intents.ts) first, like T20: a race card takes the attempt's state into
    // `candidates` and closes `superseded` when nobody on it is in flight anymore; every other
    // open non-choice card goes `stale`. The states read here are pre-stop, as the engine's are.
    const states = new Map<string, string>();
    for (const row of sql.exec("SELECT attempt_id, state FROM attempts").toArray()) {
      states.set(String(row.attempt_id), String(row.state));
    }
    for (const row of sql.exec("SELECT card_id, kind, body FROM cards WHERE state = 'open'").toArray()) {
      const card_id = String(row.card_id);
      const kind = String(row.kind);
      const body = JSON.parse(String(row.body)) as Card;
      if (!body.attempt_ids.includes(a.attempt_id)) continue;
      if (kind === "race") {
        body.candidates ??= {};
        const cand = body.candidates[a.attempt_id];
        if (cand === undefined) {
          body.candidates[a.attempt_id] = {
            state: a.state as AttemptState,
            can_choose: false,
            seconds: null,
            cost_usd: null,
          };
        } else {
          cand.state = a.state as AttemptState;
          cand.can_choose = false;
        }
        const inFlight = body.attempt_ids.some((id) => {
          const state = states.get(id);
          return state !== undefined && state !== "stopped" && state !== "accepted" && state !== "landed";
        });
        sql.exec("UPDATE cards SET body = ? WHERE card_id = ?", JSON.stringify(body), card_id);
        appendEvent(sql, now, { ts: now, pool, src: "trunk", type: "card.updated", card: body });
        if (!inFlight) {
          sql.exec("UPDATE cards SET state = 'closed', closed_at = ? WHERE card_id = ?", now, card_id);
          appendEvent(sql, now, {
            ts: now,
            pool,
            src: "trunk",
            type: "card.closed",
            card_id,
            action: "superseded",
            by: "system",
            attempt_id: null,
            reason: null,
          });
        }
        continue;
      }
      if (kind === "choice") continue;
      sql.exec("UPDATE cards SET state = 'closed', closed_at = ? WHERE card_id = ?", now, card_id);
      appendEvent(sql, now, {
        ts: now,
        pool,
        src: "trunk",
        type: "card.closed",
        card_id,
        action: "stale",
        by: "system",
        attempt_id: null,
        reason: null,
      });
    }
    sql.exec(
      "UPDATE attempts SET state = 'stopped', stop_reason = 'reopen_failed', approved_by = NULL, updated_at = ? WHERE attempt_id = ?",
      now,
      a.attempt_id,
    );
    appendEvent(sql, now, {
      ts: now,
      pool,
      src: "trunk",
      type: "attempt.state",
      attempt_id: a.attempt_id,
      from: a.state,
      to: "stopped",
      transition: "T20r",
      reason: "reopen_failed",
      go_arounds: a.go_arounds,
      pull_backs: a.pull_backs,
      right_of_way: a.right_of_way_at !== null,
    });
    // CD5: the card's texts are filled from the copy module before the premises it names go.
    const intentText = String(
      sql.exec("SELECT text FROM intents WHERE intent_id = ?", a.intent_id).toArray()[0]?.text ?? "",
    );
    const attemptMeta = sql.exec("SELECT race, model FROM attempts WHERE attempt_id = ?", a.attempt_id).toArray()[0];
    const name = changeName({
      intentText,
      race: Number(attemptMeta?.race ?? 0) === 1,
      model: attemptMeta?.model === null || attemptMeta?.model === undefined ? null : String(attemptMeta.model),
      premises: sql
        .exec("SELECT kind, key, edit, hash FROM premises WHERE attempt_id = ?", a.attempt_id)
        .toArray()
        .map((p) => ({ kind: String(p.kind), key: String(p.key), edit: Number(p.edit) === 1, hash: String(p.hash) })),
    });
    // T20r: the attempt is not parked — its premises and operations are deleted.
    sql.exec("DELETE FROM premises WHERE attempt_id = ?", a.attempt_id);
    sql.exec("DELETE FROM ops WHERE attempt_id = ?", a.attempt_id);
    const counter = Number(sql.exec("SELECT COUNT(*) AS m FROM cards").toArray()[0]?.m ?? 0) + 1;
    const card_id = `k_${String(counter).padStart(4, "0")}`;
    const template = CARD_TEMPLATES["choice:reopen_failed"];
    const card: Card = {
      card_id,
      kind: "choice",
      attempt_ids: [a.attempt_id],
      intent_ids: [a.intent_id],
      submit_ids: {},
      title: fill(template.title, {}),
      body: [fill(template.body, { changeName: name })],
      options: template.options.map((o) => ({ id: o.id, label: o.label })),
      paths: [],
      blast_radius: {},
      preview: null,
      candidates: null,
      risk: null,
      reason: "reopen_failed",
    };
    sql.exec(
      "INSERT INTO cards (card_id, kind, state, body, created_at, closed_at) VALUES (?, ?, 'open', ?, ?, NULL)",
      card_id,
      "choice",
      JSON.stringify(card),
      now,
    );
    appendEvent(sql, now, { ts: now, pool, src: "trunk", type: "card.opened", card });
    metaSet(sql, `${DONE}${a.attempt_id}`, a.resumes);
    metaDelete(sql, `${CYCLE}${a.attempt_id}`);
    timerDelete(sql, "resume", a.attempt_id);
  });
}

/**
 * One pass over the resume work (RS1): cycles owed are detected from `attempts.resumes`, sends
 * go to the Agent Durable Object named by the attempt id, and the answers end the cycle —
 * `{ok: true}` marks it done, `ok: false` and the deadline apply T20r, a transport failure
 * schedules the `resume` timer at HEADS_UP_REPUSH_MS.
 *
 * `now` is the due-check's clock — the alarm's `?now=` test path hands it through so the
 * deadline and the repush cadence are drivable without sleeping for the real times.
 */
export async function deliverResumes(env: Env, ctx: DurableObjectState, now?: number): Promise<void> {
  const sql = sqlOf(ctx);
  const at = now ?? Date.now();
  const rows = attempts(sql);

  // Detection: a reopened attempt (`resumes` beyond what a cycle already served) that is back
  // in flight owes a resume — the cycle is written before the first send, so a crash replays.
  for (const a of rows) {
    const done = Number(metaGet(sql, `${DONE}${a.attempt_id}`) ?? "0");
    if (a.resumes <= done) continue;
    const stale = cycleOf(sql, a.attempt_id);
    if (stale !== null && stale.resume_n !== a.resumes) {
      sql.transaction(() => metaDelete(sql, `${CYCLE}${a.attempt_id}`));
    } else if (stale !== null) {
      continue; // the cycle below serves it
    }
    if (cycleOf(sql, a.attempt_id) !== null) continue;
    if (!REOPEN_STATES.has(a.state)) {
      // It stopped or landed on its own before any cycle ran: no Agent to start.
      if (a.state === "stopped" || a.state === "landed") endCycle(sql, a.attempt_id, a.resumes);
      continue;
    }
    // The deadline is a schedule, so it stays real-time like every other timer (`?now=` drives
    // the due-check alone, LP5a); `next_send` is the due-check side, so `at` sends at once.
    const cycle: ResumeCycle = {
      resume_n: a.resumes,
      revision: a.revision,
      cause: causeOf(sql, a.attempt_id),
      deadline: Date.now() + RESUME_ACK_TIMEOUT_MS,
      next_send: at,
      since_call: a.last_call_id,
    };
    sql.transaction(() => metaSet(sql, `${CYCLE}${a.attempt_id}`, JSON.stringify(cycle)));
  }

  // Serving: every open cycle, in attempt order. The guard column of T20r — "the attempt took
  // no step since T19 or T21" — reads `last_call_id` against the detection-time value.
  for (const a of rows) {
    const done = Number(metaGet(sql, `${DONE}${a.attempt_id}`) ?? "0");
    if (a.resumes <= done) continue;
    const cycle = cycleOf(sql, a.attempt_id);
    if (cycle === null || cycle.resume_n !== a.resumes) continue;
    if (!REOPEN_STATES.has(a.state)) {
      endCycle(sql, a.attempt_id, a.resumes);
      continue;
    }
    if (a.last_call_id !== cycle.since_call) {
      // The Agent took a step on its own: the resume's purpose is served without the answer.
      endCycle(sql, a.attempt_id, a.resumes);
      continue;
    }
    if (at >= cycle.deadline) {
      applyReopenFailed(ctx, a, at);
      continue;
    }
    if (cycle.next_send > at) continue;
    const request: ResumeRequest = {
      attempt_id: a.attempt_id,
      revision: cycle.revision,
      cause: cycle.cause,
      resume_n: cycle.resume_n,
    };
    // RS4's two failures: the Agent answered `ok: false` (RS3's refusals), which ends the
    // cycle at once, or `ok` has not arrived by the deadline — a transport failure, a non-2xx
    // or an unparseable answer all count as "not arrived" and keep the repush cadence.
    let refused = false;
    try {
      const response = await env.AGENT.get(env.AGENT.idFromName(a.attempt_id)).fetch(RESUME_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as ResumeResponse | null;
        if (body !== null && body.ok === true) {
          endCycle(sql, a.attempt_id, a.resumes);
          continue;
        }
        refused = body !== null && body.ok === false;
      }
    } catch {
      // transport: the repush cadence below carries it
    }
    if (refused) {
      // RS4: the Agent refused — T20r unless a step already applied since detection.
      if (a.last_call_id === cycle.since_call) {
        applyReopenFailed(ctx, a, at);
      } else {
        endCycle(sql, a.attempt_id, a.resumes);
      }
      continue;
    }
    const next = Date.now() + HEADS_UP_REPUSH_MS;
    sql.transaction(() => {
      const live = cycleOf(sql, a.attempt_id);
      if (live === null || live.resume_n !== cycle.resume_n) return;
      live.next_send = next;
      metaSet(sql, `${CYCLE}${a.attempt_id}`, JSON.stringify(live));
      timerPut(sql, "resume", a.attempt_id, next);
    });
  }

  // RS1's "at least once": a live cycle always has its `resume` timer. A pass that stopped
  // early — a store failure mid-send — would otherwise leave the cycle asleep until some
  // unrelated request happened to re-run the pipeline.
  for (const a of attempts(sql)) {
    const live = cycleOf(sql, a.attempt_id);
    if (live === null || live.resume_n !== a.resumes) continue;
    if (timerGetDue(sql, "resume", a.attempt_id) === null) {
      sql.transaction(() => timerPut(sql, "resume", a.attempt_id, live.next_send));
    }
  }
}
