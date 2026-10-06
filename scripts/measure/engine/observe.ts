// The run's view of one pool's event stream: the events of the run's own intent and attempt,
// reduced to the facts the scoring of 6.5/ME7/ME8 needs. Pure: a list of `PoolEvent`s goes in,
// an `Observation` comes out; nothing is fetched and nothing is executed (ME6).

import type { PoolEvent } from "../../../src/protocol/events.ts";

export type StepObs = {
  tool: string | null;
  target: string | null;
  ok: boolean;
  error: string | null;
  ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  n: number;
  ts: number;
};

export type HeadsUpObs = {
  hn: number;
  result: "info" | "confirm" | "repair";
  keys: Array<{ kind: string; key: string; rule: string }>;
  n: number;
  ts: number;
};

export type Observation = {
  /** `ts` of our intent's `intent.created`. */
  intentCreatedTs: number | null;
  /** The first real `attempt.opened` for our intent (null: the agent never opened). */
  attemptId: string | null;
  /** `model` of that first `attempt.opened` (the deployment's workhorse, ME7's check). */
  openedModel: string | null;
  /** Real attempts opened for our intent — a second one disqualifies `landed` (6.8). */
  openedCount: number;
  /** Our attempt's `attempt.step` events in stream order. */
  steps: StepObs[];
  /** Our attempt's `submit.result` statuses in stream order. */
  submits: Array<{ status: string; n: number; ts: number }>;
  /** Our attempt's `op.recorded` (op_seq and path) in stream order. */
  opsRecorded: Array<{ op_seq: number; path: string; op: string; n: number }>;
  /** Op seqs of our attempt dropped anywhere: `op.dropped` and every heads-up's `dropped_ops`. */
  opsDropped: Set<number>;
  /** Our attempt's `headsup.sent` in stream order. */
  headsUps: HeadsUpObs[];
  /** Our attempt's `headsup.resolved` in stream order. */
  resolved: Array<{ hn: number; result: string; statement: string; changed: boolean; n: number; ts: number }>;
  /** Our attempt's `landing.accepted`, if the change was accepted into a batch. */
  accepted: { seq: number; paths: string[]; n: number; ts: number } | null;
  /** The `landing.landed` of that same `seq`. */
  landed: { seq: number; commit: string; note_json: string | null; n: number; ts: number } | null;
  /** Our attempt's `attempt.state` to `stopped`. */
  stopped: { reason: string | null; n: number } | null;
  /** `pool.paused`, if the pool stopped mid-run. */
  paused: { reason: string; detail: string } | null;
  /** `card.closed` with `by: "owner"` naming our attempt (a card action disqualifies `landed`). */
  ownerCardActions: number;
  /** Every `limits` event, in order (the gate's spend/reserve counters, deployment-wide). */
  limits: Array<{ spend_usd: number; reserved_usd: number; n: number }>;
  /** The created pool's first `pool.state` (its `summary_only` flag is EV6's check). */
  poolState: { summary_only: boolean } | null;
  /** `landing.accepted` seq -> `attempt_id` of every accepted change (to name `landing.landed`). */
  acceptedBySeq: Map<number, string | null>;
};

/** The submit statuses that pass the checks of 4.9/5.x (14.7 names validated, submitted, held;
 * `accepted` and `landed` are the synchronous answers of an already-decided submit). */
const PASSING_SUBMIT = new Set(["validated", "submitted", "held", "accepted", "landed"]);

export function passingSubmit(status: string): boolean {
  return PASSING_SUBMIT.has(status);
}

/**
 * Reduce `events` (a pool stream's `PoolEvent`s in `n` order) to the facts of the run of
 * `intentId`. The run's attempt is the first `attempt.opened` with `agent: "real"` on that intent.
 */
export function observe(events: readonly PoolEvent[], intentId: string): Observation {
  const obs: Observation = {
    intentCreatedTs: null,
    attemptId: null,
    openedModel: null,
    openedCount: 0,
    steps: [],
    submits: [],
    opsRecorded: [],
    opsDropped: new Set<number>(),
    headsUps: [],
    resolved: [],
    accepted: null,
    landed: null,
    stopped: null,
    paused: null,
    ownerCardActions: 0,
    limits: [],
    poolState: null,
    acceptedBySeq: new Map<number, string | null>(),
  };
  for (const e of events) {
    switch (e.type) {
      case "pool.state":
        if (obs.poolState === null) obs.poolState = { summary_only: e.summary_only };
        break;
      case "intent.created":
        if (e.intent_id === intentId && obs.intentCreatedTs === null) obs.intentCreatedTs = e.ts;
        break;
      case "attempt.opened":
        if (e.intent_id === intentId && e.agent === "real") {
          obs.openedCount++;
          if (obs.attemptId === null) {
            obs.attemptId = e.attempt_id;
            obs.openedModel = e.model;
          }
        }
        break;
      case "pool.paused":
        obs.paused = { reason: e.reason, detail: e.detail };
        break;
      case "limits":
        obs.limits.push({ spend_usd: e.spend_usd, reserved_usd: e.reserved_usd, n: e.n });
        break;
      case "landing.accepted":
        obs.acceptedBySeq.set(e.seq, e.attempt_id);
        if (e.attempt_id !== null && e.attempt_id === obs.attemptId && obs.accepted === null) {
          obs.accepted = { seq: e.seq, paths: e.paths, n: e.n, ts: e.ts };
        }
        break;
      case "landing.landed":
        if (obs.accepted !== null && e.seq === obs.accepted.seq) {
          obs.landed = { seq: e.seq, commit: e.commit, note_json: e.note_json, n: e.n, ts: e.ts };
        }
        break;
      default:
        if (obs.attemptId === null || !("attempt_id" in e) || e.attempt_id !== obs.attemptId) break;
        switch (e.type) {
          case "attempt.step":
            obs.steps.push({
              tool: e.tool,
              target: e.target,
              ok: e.ok,
              error: e.error,
              ms: e.ms,
              tokens_in: e.tokens_in,
              tokens_out: e.tokens_out,
              cost_usd: e.cost_usd,
              n: e.n,
              ts: e.ts,
            });
            break;
          case "attempt.state":
            if (e.to === "stopped" && obs.stopped === null) obs.stopped = { reason: e.reason, n: e.n };
            break;
          case "submit.result":
            obs.submits.push({ status: e.status, n: e.n, ts: e.ts });
            break;
          case "op.recorded":
            obs.opsRecorded.push({ op_seq: e.op_seq, path: e.path, op: e.op, n: e.n });
            break;
          case "op.dropped":
            for (const seq of e.op_seqs) obs.opsDropped.add(seq);
            break;
          case "headsup.sent":
            obs.headsUps.push({
              hn: e.hn,
              result: e.result,
              keys: e.keys.map((k) => ({ kind: String(k.kind), key: k.key, rule: k.rule })),
              n: e.n,
              ts: e.ts,
            });
            for (const dropped of e.dropped_ops) obs.opsDropped.add(dropped.op_seq);
            break;
          case "headsup.resolved":
            obs.resolved.push({
              hn: e.hn,
              result: e.result,
              statement: e.statement,
              changed: e.changed,
              n: e.n,
              ts: e.ts,
            });
            break;
          case "card.closed":
            if (e.by === "owner") obs.ownerCardActions++;
            break;
        }
    }
  }
  return obs;
}
