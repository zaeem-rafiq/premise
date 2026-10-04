// The pool's event stream: envelope and the PoolEvent union.
// Source: 01-core 12.1 (envelope and types), 12.2 (sources and numbering).

import type { PremiseKind, PremiseRef } from "./premise.ts";
import type { AttemptState } from "./attempt.ts";
import type { HeadsUp, HeadsUpItem } from "./headsup.ts";
import type { Card, CardOption } from "./cards.ts";
import type { Note } from "./note.ts";
import type { SubmitResult, Check } from "./tools.ts";
import type { VerifyResult } from "./green.ts";
import type { UndoRefusal } from "./undo.ts";

export type EventBase = {
  n: number; // position in the pool's stream: 1, 2, 3, ... no gaps
  t: number; // ms since epoch: arrival at the Floor (assigned on append)
  ts: number; // ms since epoch: the source's clock when the state change committed
  pool: string;
  src: "trunk" | "agent" | "gate" | "swarm" | "floor"; // who emitted it (EV2a)
  type: string;
};

/** SE5b: a code from a fixed list, for example "transport", "timeout", "http_503", "rejected", "rate_limited". */
export type ErrCode = string;

export const EVENT_SOURCES = ["trunk", "agent", "gate", "swarm", "floor"] as const;

export type EventSrc = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPES = [
  "pool.state",
  "pool.files",
  "pool.paused",
  "trunk.error",
  "intent.created",
  "intent.state",
  "attempt.opened",
  "attempt.state",
  "attempt.reopened",
  "attempt.step",
  "attempt.repo",
  "premise.recorded",
  "premise.removed",
  "premise.judged",
  "op.recorded",
  "op.dropped",
  "headsup.sent",
  "headsup.resolved",
  "submit.result",
  "card.opened",
  "card.updated",
  "card.closed",
  "landing.accepted",
  "landing.landed",
  "batch.pushed",
  "push.retry",
  "tick.skipped",
  "undo.planned",
  "undo.refused",
  "plain.updated",
  "green.verified",
  "green.advanced",
  "metrics",
  "limits",
  "swarm.state",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type PoolEvent = EventBase &
  (
    | {
        type: "pool.state";
        head_seq: number;
        head_commit: string;
        green_seq: number;
        landed_seq: number;
        landed_commit: string; // the last landing confirmed on main
        state: "ready" | "rebuilding" | "paused";
        reason: string | null;
        epoch: number;
        remote: string; // the pool repo's address, without credentials
        plain_remote: string | null;
        rebuild: { done: number; total: number } | null;
        unwitnessed: number[];
        real_agents: number;
        max_real_agents: number;
        synthetic: boolean; // a synthetic attempt was opened in this pool (EM1a): the SYNTHETIC banner
        summary_only: boolean; // the pool's flag, fixed at creation (PL1, EV6)
      }
    | { type: "pool.files"; files: Array<{ path: string; tier: "auto" | "held" }> }
    | {
        type: "pool.paused";
        reason: "diverged" | "push_rejected" | "note_seq_mismatch" | "owner";
        detail: ErrCode;
      }
    | { type: "trunk.error"; where: string; code: ErrCode }
    | {
        type: "intent.created";
        intent_id: string;
        text: string;
        requester: string;
        race: boolean;
        prewritten: boolean;
      }
    | { type: "intent.state"; intent_id: string; state: "open" | "landed" | "stopped" | "undone" }
    | {
        type: "attempt.opened";
        attempt_id: string;
        intent_id: string;
        change_id: string;
        agent: "real" | "synthetic";
        model: string | null;
        race: boolean;
      }
    | {
        type: "attempt.state";
        attempt_id: string;
        from: AttemptState;
        to: AttemptState;
        transition: string;
        reason: string | null;
        go_arounds: number;
        pull_backs: number;
        right_of_way: boolean;
      }
    | {
        type: "attempt.reopened";
        attempt_id: string;
        cause: "undo" | "revert" | "retry";
        revision: number;
        model_changed: boolean;
      }
    | {
        type: "attempt.step";
        attempt_id: string;
        step: number;
        tool: string | null; // null = model turn
        target: string | null;
        ok: boolean;
        error: ErrCode | null;
        ms: number;
        tokens_in: number | null;
        tokens_out: number | null;
        cost_usd: number | null; // model turns only
      }
    | { type: "attempt.repo"; attempt_id: string; ok: boolean; ms: number; error: ErrCode | null }
    | { type: "premise.recorded"; attempt_id: string; premise: PremiseRef; tool: string }
    | { type: "premise.removed"; attempt_id: string; kind: PremiseKind; key: string; rule: string }
    | {
        type: "premise.judged";
        attempt_id: string;
        kind: PremiseKind;
        key: string;
        old_hash: string;
        new_hash: string;
        cause: string;
        cause_seq: number | null;
        rule: string;
        class: "rule" | "triage";
        result: "holds" | "confirm" | "repair" | null;
        reason: string;
        clef: { model: string; p: number | null; error: ErrCode | null } | null;
      }
    | {
        type: "op.recorded";
        attempt_id: string;
        op_seq: number;
        op: "write" | "replace";
        path: string;
        targets: string[];
        altered: string[];
        added: string[];
        removed: string[];
      }
    | { type: "op.dropped"; attempt_id: string; op_seqs: number[]; path: string; rule: string }
    | {
        type: "headsup.sent";
        attempt_id: string;
        hn: number;
        result: "info" | "confirm" | "repair";
        wake: boolean;
        cause: HeadsUp["cause"];
        keys: Array<{ kind: PremiseKind | "check"; key: string; rule: string }>;
        items: HeadsUpItem[] | null; // the items as sent (8.2); null in a summary_only pool (EV6)
        dropped_ops: HeadsUp["dropped_ops"];
        go_around: number | null;
      }
    | {
        type: "headsup.resolved";
        attempt_id: string;
        hn: number;
        result: "confirm" | "repair";
        go_around: number | null; // as in the heads-up
        changed: boolean; // HU12: the attempt's operations differ from when it was sent back
        statement: string;
      }
    | {
        type: "submit.result";
        attempt_id: string;
        submit_id: string | null;
        status: SubmitResult["status"];
        tier: "auto" | "held" | null;
        checks: Check[];
        duplicate: boolean;
      }
    | { type: "card.opened"; card: Card }
    | { type: "card.updated"; card: Card }
    | {
        type: "card.closed";
        card_id: string;
        action: CardOption | "stale" | "superseded";
        by: "owner" | "system";
        attempt_id: string | null; // the chosen candidate when action is "choose" (CD1)
        reason: string | null; // only the reason the owner typed
      }
    | {
        type: "landing.accepted";
        seq: number;
        batch_id: number;
        kind: "change" | "undo" | "revert";
        attempt_id: string | null;
        change_id: string;
        intent_id: string | null;
        request_id: string | null;
        paths: string[];
        writes: Note["writes"];
      }
    | {
        type: "landing.landed";
        seq: number;
        batch_id: number;
        commit: string;
        tree: string;
        note: string; // the note's git blob id
        note_json: string | null; // the note itself (3.5); null in a summary_only pool (EV6)
        time_to_land_ms: number | null;
      }
    | {
        type: "batch.pushed";
        batch_id: number;
        first_seq: number;
        last_seq: number;
        main: string;
        notes: string;
        tries: number;
        ms: number;
      }
    | { type: "push.retry"; batch_id: number; tries: number; error: ErrCode; next_try_ms: number }
    | {
        type: "tick.skipped";
        attempt_id: string;
        why: "not_disjoint" | "right_of_way" | "checks_failed" | "held";
        behind: string | null;
      }
    | {
        type: "undo.planned";
        request_id: string;
        cause: "undo" | "revert";
        target_seq: number;
        reverted: number[];
        reopened: string[];
        kept_readers: number[];
      }
    | {
        type: "undo.refused";
        request_id: string;
        target_seq: number;
        reason: UndoRefusal;
      }
    | {
        type: "plain.updated";
        commit: string;
        tree: string;
        through_seq: number;
        skipped: number[];
        interrupted: number[];
      }
    | {
        type: "green.verified";
        seq: number;
        commit: string;
        ok: boolean;
        runtime: VerifyResult["runtime"];
        checks: VerifyResult["checks"];
        ms: number;
        confirmed: boolean; // GR3: true for a pass, and for the second failed run on one commit
      }
    | { type: "green.advanced"; seq: number; commit: string }
    | {
        type: "metrics";
        window_ms: number;
        landings_per_second: number;
        time_to_land_ms: { p50: number | null; p99: number | null };
        time_held_ms: { p50: number | null; p99: number | null };
        go_around_rate: number | null;
        false_abort_rate: number | null;
        escape_rate: number | null;
        waiting_behind: number;
        push_backlog: number;
        tick_cpu_ms: { p50: number | null; p99: number | null };
      }
    | {
        type: "limits";
        spend_usd: number;
        reserved_usd: number;
        cap_usd: number;
        killed: boolean;
        refusing: boolean;
        models: Array<{ model: string; per_minute: number; used_last_minute: number }>;
      }
    | {
        type: "swarm.state";
        synthetic: true;
        running: boolean;
        agents: number;
        collision_dial: number;
        pools: string[];
      }
  );
