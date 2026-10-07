// The resume delivery of RS1 and the T20r fallback of RS4 (01-core 8.3, 9.2, 10.3): a T19 or
// T21 transaction adds 1 to `attempts.resumes` and emits `attempt.reopened`; after the commit
// the shell owes the attempt's Agent Durable Object a `resume` call — sent at once, repeated
// every HEADS_UP_REPUSH_MS until the Agent answers, for at most RESUME_ACK_TIMEOUT_MS from
// the first send. An `ok: false`, or silence at the deadline, stops the attempt
// `reopen_failed` and opens the choice card of UN6 — T20r — unless the attempt took a step
// of its own meanwhile (T20r's "took no step" guard, read on `last_call_id`).
//
// The engine owns T20r and updates its retained Pool in the same transaction as the rows.
// The shell owns delivery, deadlines and the durable resume-cycle bookkeeping.

import { HEADS_UP_REPUSH_MS, RESUME_ACK_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { ResumeRequest, ResumeResponse } from "../../protocol/tools.ts";
import type { AgentOpenRequest, AgentOpenResponse } from "../../protocol/internal.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { ScriptedTriage } from "../../swarm/scripted-triage.ts";
import { FEATURES } from "../../config/features.ts";
import {
  metaAll,
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
const NEW_AGENT = "new_agent_open:";
const NEW_AGENT_CYCLE = "new_agent_cycle:";

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

function attemptRow(row: Record<string, unknown>): AttemptRow {
  return {
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
  };
}

function readAttempt(sql: Sql, attempt_id: string): AttemptRow | null {
  const row = sql.exec("SELECT * FROM attempts WHERE attempt_id = ?", attempt_id).toArray()[0];
  return row === undefined ? null : attemptRow(row);
}

function attempts(sql: Sql): AttemptRow[] {
  return sql
    .exec(
      `SELECT attempt_id, intent_id, resumes, revision, state, last_call_id, go_arounds,
              pull_backs, right_of_way_at
       FROM attempts WHERE resumes > 0`,
    )
    .toArray()
    .map(attemptRow);
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
  // The transition stores the cause with the revision, so an event delivery or restart
  // cannot turn an undo/revert into a retry before the first resume send.
  const stored = metaGet(sql, `resume_cause:${attempt_id}`);
  let cause: ResumeCycle["cause"] = stored === "undo" || stored === "revert" ? stored : "retry";
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
function applyReopenFailed(
  ctx: DurableObjectState,
  a: AttemptRow,
  cycle: ResumeCycle,
  now: number,
  onCommit: () => void,
): void {
  sqlOf(ctx).run("resume_failed", { now: () => now, syncTriage: ScriptedTriage, features: FEATURES }, (trunk) =>
    trunk.resumeFailed({ attempt_id: a.attempt_id, resume_n: cycle.resume_n, since_call: cycle.since_call }),
  );
  onCommit();
}

function stopLost(ctx: DurableObjectState, attempt_id: string, at: number, onCommit: () => void): void {
  sqlOf(ctx).run("stop", { now: () => at, syncTriage: ScriptedTriage, features: FEATURES }, (trunk) =>
    trunk.stop({ attempt_id, reason: "lost" }),
  );
  onCommit();
}

/** UN6a: an explicit new-attempt choice starts a fresh model driver, not a resume.
 * The engine writes its open request and timer with the new attempt. Retrying that request
 * is safe because Agent /open is idempotent by attempt id. */
async function deliverNewAgents(env: Env, ctx: DurableObjectState, at: number, onCommit: () => void): Promise<void> {
  const sql = sqlOf(ctx);
  const finish = (attempt_id: string): void => {
    sql.transaction(() => {
      metaDelete(sql, `${NEW_AGENT}${attempt_id}`);
      metaDelete(sql, `${NEW_AGENT_CYCLE}${attempt_id}`);
      timerDelete(sql, "resume", attempt_id);
    });
  };
  for (const [key, raw] of Object.entries(metaAll(sql))) {
    if (!key.startsWith(NEW_AGENT)) continue;
    const request = JSON.parse(raw) as AgentOpenRequest;
    const id = request.attempt_id;
    const a = readAttempt(sql, id);
    if (a === null || ["stopped", "accepted", "landed"].includes(a.state)) {
      finish(id);
      continue;
    }
    const cycleKey = `${NEW_AGENT_CYCLE}${id}`;
    const stored = metaGet(sql, cycleKey);
    const cycle: { deadline: number; next_send: number; since_call: string | null } =
      stored === null
        ? { deadline: Date.now() + RESUME_ACK_TIMEOUT_MS, next_send: at, since_call: a.last_call_id }
        : JSON.parse(stored);
    if (a.last_call_id !== cycle.since_call) {
      finish(id); // A previous open reached the Agent and it has already taken a step.
      continue;
    }
    if (at >= cycle.deadline) {
      // This Agent has never resumed: T20r only follows T19/T21. A fresh Agent
      // that cannot start is lost (T20), rather than an orphan in `opened`.
      stopLost(ctx, id, at, onCommit);
      finish(id);
      continue;
    }
    if (cycle.next_send > at) {
      sql.transaction(() => timerPut(sql, "resume", id, cycle.next_send));
      continue;
    }
    // Write the retry before sending, so a process loss during /open leaves a wake-up.
    cycle.next_send = Date.now() + HEADS_UP_REPUSH_MS;
    sql.transaction(() => {
      metaSet(sql, cycleKey, JSON.stringify(cycle));
      timerPut(sql, "resume", id, cycle.next_send);
    });
    let refused = false;
    try {
      const response = await env.AGENT.get(env.AGENT.idFromName(id)).fetch("https://agent/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const answer = (await response.json().catch(() => null)) as AgentOpenResponse | null;
      if (response.ok && answer?.ok === true) {
        finish(id);
        continue;
      }
      refused = response.ok && answer?.ok === false;
    } catch {
      // The durable resume timer retries the same open request until the deadline.
    }
    if (refused) {
      // /open yielded: another request may have advanced or stopped this attempt meanwhile.
      const current = readAttempt(sql, id);
      if (
        current !== null &&
        !["stopped", "accepted", "landed"].includes(current.state) &&
        current.last_call_id === cycle.since_call
      )
        stopLost(ctx, id, at, onCommit);
      finish(id);
    }
  }
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
export async function deliverResumes(
  env: Env,
  ctx: DurableObjectState,
  now?: number,
  // The shell dispatches events here, after the engine transaction and before any next send.
  onCommit: () => void = () => {},
): Promise<void> {
  const sql = sqlOf(ctx);
  const at = now ?? Date.now();
  await deliverNewAgents(env, ctx, at, onCommit);
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
      applyReopenFailed(ctx, a, cycle, at, onCommit);
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
      const current = readAttempt(sql, a.attempt_id);
      if (
        current !== null &&
        current.resumes === cycle.resume_n &&
        REOPEN_STATES.has(current.state) &&
        current.last_call_id === cycle.since_call
      ) {
        applyReopenFailed(ctx, current, cycle, at, onCommit);
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
