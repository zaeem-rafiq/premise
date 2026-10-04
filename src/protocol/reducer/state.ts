// `FloorState`: the shape the reducer produces for the Floor page (03-floor 4.1). Every event type
// moves a part of it (03-floor 4.3); the page, the app server and the note and replay routes all read
// it (01-core FS1, FS2). One addition over 03-floor 4.1: `go_around_log`, the small ledger metric
// 14.4 needs — the spec's state names no field for it, and the metric cannot be computed without it.
//
// Only JSON values live here (null, numbers, strings, booleans, arrays, records), so a state survives
// a JSON round trip unchanged: snapshots and hibernation joins reduce identically (FE3).

import type { PoolEvent } from "../events.ts";
import type { PremiseKind } from "../premise.ts";
import type { AttemptState } from "../attempt.ts";
import type { HeadsUp, HeadsUpItem, HeadsUpResult } from "../headsup.ts";
import type { Card, CardAction, CardOption, RiskAnswers } from "../cards.ts";
import type { Note } from "../note.ts";
import type { Check, SubmitResult } from "../tools.ts";
import type { VerifyResult } from "../green.ts";

/** The newest `metrics` event, kept whole (03-floor 4.1: "the `metrics` member of PoolEvent"). */
export type MetricsEvent = Extract<PoolEvent, { type: "metrics" }>;

/** One premise's state on an attempt card (03-floor 4.1 `PremiseView`). */
export type PremiseView = {
  kind: PremiseKind;
  key: string;
  read: boolean;
  edit: boolean;
  derived: boolean;
  light: "holds" | "changed" | "confirm" | "blind_spot" | "checking";
  judgment: {
    rule: string;
    reason: string;
    result: "holds" | "confirm" | "repair" | null;
    cause_seq: number | null;
    clef: { model: string; p: number | null; error: string | null } | null;
  } | null;
};

/** One heads-up of an attempt (03-floor 4.1 `HeadsUpView`). */
export type HeadsUpView = {
  hn: number;
  result: HeadsUpResult;
  wake: boolean;
  ts: number;
  cause: HeadsUp["cause"];
  go_around: number | null;
  keys: Array<{ kind: PremiseKind | "check"; key: string; rule: string }>;
  items: HeadsUpItem[] | null; // as sent (01-core 8.2); null in a summary_only pool
  dropped_ops: HeadsUp["dropped_ops"];
  resolved: { statement: string; changed: boolean; ts: number } | null;
};

/** One attempt card (03-floor 4.1 `AttemptView`). */
export type AttemptView = {
  id: string;
  intent_id: string;
  change_id: string;
  agent: "real" | "synthetic";
  model: string | null;
  race: boolean; // how the attempt started (attempt.opened.race); it never changes (RC7)
  state: AttemptState;
  stop_reason: string | null;
  go_arounds: number;
  pull_backs: number;
  right_of_way: boolean;
  revision: number;
  reopened_by: "undo" | "revert" | "retry" | null;
  model_changed: boolean;
  opened_ts: number;
  last_event_ts: number;
  step: { n: number; tool: string | null; target: string | null; ok: boolean; error: string | null; ts: number } | null;
  steps: number;
  premises: Record<string, PremiseView>; // key = kind + " " + key
  ops: Array<{
    op_seq: number;
    op: "write" | "replace";
    path: string;
    dropped: boolean;
    altered: string[];
    added: string[];
    removed: string[];
  }>;
  heads_ups: Record<number, HeadsUpView>;
  submit: {
    submit_id: string | null;
    status: SubmitResult["status"];
    tier: "auto" | "held" | null;
    checks: Check[];
    ts: number;
  } | null;
  repair_open_ts: number | null; // 14.7: ts of the `repair` heads-up that started the open go-around
  skipped: { why: "not_disjoint" | "right_of_way" | "checks_failed" | "held"; behind: string | null } | null;
  card_id: string | null;
  approved_ts: number | null; // set when the owner lands or chooses it on a card
  landed_seq: number | null; // set by landing.accepted; "Landed" needs LandingView.landed
  cost_usd: number | null; // sum of attempt.step.cost_usd; null until a model turn reported one
  top_ts: number | null; // CO9 bookkeeping: ts the attempt entered the rail's top group, null outside it
};

/** One landing, in full while it is among the newest FLOOR_KEEP_LANDINGS (03-floor 4.1 `LandingView`). */
export type LandingView = {
  digest?: false;
  seq: number;
  kind: "change" | "undo" | "revert";
  batch_id: number;
  attempt_id: string | null;
  change_id: string;
  intent_id: string | null;
  request_id: string | null; // for kind undo or revert: the request_id of its undo.planned (EM4)
  paths: string[];
  writes: Note["writes"];
  accepted_ts: number;
  landed: { commit: string; tree: string; note_id: string; ts: number; time_to_land_ms: number | null } | null;
  undone_by: number | null;
  premises: PremiseView[]; // frozen at acceptance, lights as they were (all hold)
  go_arounds: HeadsUpView[]; // resolved heads-ups of result repair
  confirms: HeadsUpView[]; // resolved heads-ups of result confirm
  checks: Check[];
  tier: "auto" | "held" | null;
  approved: { by: "owner"; option: "land" | "land_now" | "choose"; card_reason: Card["reason"]; ts: number } | null;
  risk: RiskAnswers | null;
  note: Note | null; // parsed from landing.landed.note_json; null in a summary_only pool
};

/**
 * An older landing outside FLOOR_KEEP_LANDINGS (FS1: "older ones as one summary line each"). Keeps
 * what the derived values and the app server's reads still need: the seq/commit pair for `PoolSource`,
 * the paths for AS11 and `whyTarget`, the premise keys for `whoRelies`, and `undone_by`.
 */
export type LandingDigest = {
  digest: true;
  seq: number;
  kind: "change" | "undo" | "revert";
  batch_id: number;
  attempt_id: string | null;
  change_id: string;
  intent_id: string | null;
  request_id: string | null;
  paths: string[];
  premise_keys: Array<{ kind: PremiseKind; key: string }>;
  accepted_ts: number;
  landed_ts: number | null;
  commit: string | null;
  tree: string | null;
  undone_by: number | null;
};

/** `landings` holds full views for the newest landings and digests for the older ones (FS1). */
export type LandingEntry = LandingView | LandingDigest;

/** One card (03-floor 4.1 `CardView`). */
export type CardView = {
  card: Card;
  open: boolean;
  opened_ts: number;
  closed: {
    action: CardOption | "stale" | "superseded";
    by: "owner" | "system";
    attempt_id: string | null; // the chosen candidate when action is "choose"
    reason: string | null; // only the reason the owner typed
    ts: number;
  } | null;
};

/** One file of the pool (03-floor 4.1 `files`). */
export type FileView = {
  path: string;
  exists: boolean;
  tier: "auto" | "held" | null;
  readers: string[]; // attempt ids in flight
  writers: string[]; // attempt ids in flight
  last_landed_seq: number | null; // seq of the last confirmed landing that changed it (FS2)
  keys: string[]; // entity keys of this path seen in premises or writes
};

/** The reducer's output (03-floor 4.1 `FloorState`). */
export type FloorState = {
  n: number; // last event applied; 0 before any
  ts: number; // the largest ts applied so far (the Replay time of event n, RY13)
  first_intent_ts: number | null; // start of the run clock
  unknown_events: number; // events whose type the reducer does not know (ignored)
  trunk_errors: number; // trunk.error events (About)

  pool: {
    id: string;
    state: "unknown" | "ready" | "rebuilding" | "paused";
    reason: string | null; // pause reason
    epoch: number; // rises after a rebuild from Artifacts (RB5)
    synthetic: boolean; // a synthetic attempt was opened here (EM1a): the SYNTHETIC banner
    summary_only: boolean; // the pool's flag (EV6): FE4
    head_seq: number; // last accepted landing
    head_commit: string | null; // the head landing's commit
    landed_seq: number; // last landing confirmed on main
    landed_commit: string | null; // the commit that the source `main` means
    real_agents: number;
    max_real_agents: number;
    remote: string | null; // clone address without credentials
    plain_remote: string | null; // null: the pool has no plain-merge repository
    rebuild: { done: number; total: number } | null;
    unwitnessed: number[]; // landings whose commit has no note
  };

  intents: Record<
    string,
    {
      id: string;
      text: string;
      requester: string;
      race: boolean;
      prewritten: boolean;
      state: "open" | "landed" | "stopped" | "undone";
      created_ts: number;
      attempt_ids: string[];
    }
  >;

  attempts: Record<string, AttemptView>;
  working_order: string[]; // attempt ids in rail order (CO9)

  landings: Record<number, LandingEntry>; // the newest FLOOR_KEEP_LANDINGS in full; older as digests
  landed_order: number[]; // seqs, newest first

  cards: Record<string, CardView>;
  open_cards: string[]; // card ids, oldest first

  files: Record<string, FileView>;
  dirs: Record<string, { readers: string[] }>; // listing and directory-search readers

  push: {
    batch_id: number;
    first_accepted_ts: number;
    tries: number;
    error: string | null;
    next_try_ts: number | null;
  } | null;
  last_push: { batch_id: number; landings: number; tries: number; ms: number } | null;

  green: {
    seq: number | null;
    commit: string | null;
    runtime: VerifyResult["runtime"] | null;
    last: {
      seq: number;
      ok: boolean;
      confirmed: boolean; // GR3: false for a first failed run; nothing is announced for it
      failed: Array<{ name: string; code: string }>;
    } | null;
  };

  plain: { commit: string; tree: string; through_seq: number; skipped: number[]; interrupted: number[] } | null;

  limits: {
    spend_usd: number;
    reserved_usd: number;
    cap_usd: number;
    killed: boolean;
    refusing: boolean; // SE7: the cap refused the last request
    ts: number;
    models: Array<{ model: string; per_minute: number; used_last_minute: number }>;
  } | null;

  metrics: MetricsEvent | null; // newest `metrics` event
  metrics_history: Array<{ ts: number; landings_per_second: number; go_around_rate: number | null }>; // last 60 s

  swarm: { running: boolean; agents: number; collision_dial: number; pools: string[]; ever_ran: boolean } | null;

  undo: Record<
    string,
    {
      request_id: string;
      cause: "undo" | "revert";
      target_seq: number;
      reverted: number[];
      reopened: string[];
      kept_readers: number[];
      landing_seq: number | null;
    }
  >;

  repair_ms: number[]; // 14.7: one value per ended go-around of a real attempt
  repos: { ok: number; failed: number; first_ts: number | null; last_ts: number | null }; // 14.8

  counters: { landed_changes: number; go_arounds: number };

  /**
   * 14.4 ledger, one entry per go-around a `headsup.resolved` of result `repair` named: `changed`
   * accumulates HU12 across the heads-ups of the pair (attempt_id, go_around); `end_ts` is set when
   * `attempt.state` next shows the attempt leaving `going_around` for a state other than `stopped`.
   * 03-floor 4.1 names no field for it; the metric cannot exist without it.
   */
  go_around_log: Array<{ attempt_id: string; go_around: number; changed: boolean; end_ts: number | null }>;
};

/** The key one premise takes in `AttemptView.premises` (03-floor 4.1). */
export function premiseId(kind: PremiseKind, key: string): string {
  return `${kind} ${key}`;
}

/** The state the reducer starts from: `n` 0, every collection empty, the pool unknown. */
export function emptyFloorState(): FloorState {
  return {
    n: 0,
    ts: 0,
    first_intent_ts: null,
    unknown_events: 0,
    trunk_errors: 0,
    pool: {
      id: "",
      state: "unknown",
      reason: null,
      epoch: 0,
      synthetic: false,
      summary_only: false,
      head_seq: 0,
      head_commit: null,
      landed_seq: 0,
      landed_commit: null,
      real_agents: 0,
      max_real_agents: 0,
      remote: null,
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
    },
    intents: {},
    attempts: {},
    working_order: [],
    landings: {},
    landed_order: [],
    cards: {},
    open_cards: [],
    files: {},
    dirs: {},
    push: null,
    last_push: null,
    green: { seq: null, commit: null, runtime: null, last: null },
    plain: null,
    limits: null,
    metrics: null,
    metrics_history: [],
    swarm: null,
    undo: {},
    repair_ms: [],
    repos: { ok: 0, failed: 0, first_ts: null, last_ts: null },
    counters: { landed_changes: 0, go_arounds: 0 },
    go_around_log: [],
  };
}
