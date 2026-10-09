// `reduce(state, event)`: the pure function of EV5 — one `PoolEvent` in, the next `FloorState` out,
// per the mapping table of 03-floor 4.3. It reads no clock and performs no request (FE2); every event
// leaves a valid `FloorState` (FE1), and an event of a type it does not know changes only `n`, `ts`
// and `unknown_events`. `state` is updated in place and returned; a caller that keeps earlier states
// holds JSON snapshots of them.
//
// Source notes: the per-row "State" text of 03-floor 4.3, the emission rules of 01-core EV6/EM1a/EM4
// and the metrics definitions of 01-core 14 where the state must keep what they compute.

import type { PoolEvent } from "../events.ts";
import { EVENT_TYPES } from "../events.ts";
import { ABSENT } from "../premise.ts";
import type { PremiseKind, PremiseRef } from "../premise.ts";
import { FLOOR_KEEP_LANDINGS } from "../constants.ts";
import { premiseId } from "./state.ts";
import type {
  AttemptView,
  CardView,
  FloorState,
  HeadsUpView,
  LandingDigest,
  LandingEntry,
  LandingView,
  PremiseView,
} from "./state.ts";

// ---- Small helpers ----

function fileOf(state: FloorState, path: string): NonNullable<FloorState["files"][string]> {
  return (state.files[path] ??= {
    path,
    exists: false,
    tier: null,
    readers: [],
    writers: [],
    last_landed_seq: null,
    keys: [],
  });
}

function dirOf(state: FloorState, dir: string): { readers: string[] } {
  return (state.dirs[dir] ??= { readers: [] });
}

/** `landing.landed.note_json` is the note's JSON (3.5); a malformed one is ignored, never thrown (FE1). */
function parseNote(noteJson: string | null): LandingView["note"] {
  if (noteJson === null) return null;
  try {
    return JSON.parse(noteJson) as LandingView["note"];
  } catch {
    return null;
  }
}

function addOnce(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

function dropOnce(list: string[], id: string): void {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
}

/** The path a premise of kind `entity`, `file` or a `query`/`outline`/`refs` key reads or writes. */
function premisePath(kind: PremiseKind, key: string): { path: string | null; dir: string | null } {
  if (kind === "entity") return { path: key.split("#")[0] ?? null, dir: null };
  if (kind === "file") return { path: key, dir: null };
  if (kind === "listing") return { path: null, dir: key };
  // query
  if (key.startsWith("text:")) {
    const end = key.indexOf(":", 5);
    const scope = key.slice(5, end === -1 ? undefined : end);
    return scope.endsWith("/") ? { path: null, dir: scope } : { path: scope, dir: null };
  }
  if (key.startsWith("refs:")) return { path: key.slice(5).split("#")[0] ?? null, dir: null };
  if (key.startsWith("outline:")) return { path: key.slice(8), dir: null };
  return { path: null, dir: null };
}

function markReader(state: FloorState, attemptId: string, kind: PremiseKind, key: string): void {
  const { path, dir } = premisePath(kind, key);
  if (path !== null) addOnce(fileOf(state, path).readers, attemptId);
  if (dir !== null) addOnce(dirOf(state, dir).readers, attemptId);
}

function unmarkReader(state: FloorState, attemptId: string, kind: PremiseKind, key: string): void {
  const { path, dir } = premisePath(kind, key);
  if (path !== null && state.files[path] !== undefined) dropOnce(state.files[path].readers, attemptId);
  if (dir !== null && state.dirs[dir] !== undefined) dropOnce(state.dirs[dir].readers, attemptId);
}

/** `files[path].keys`: entity keys of this path seen in premises or writes (03-floor 4.1). */
function recomputeKeys(state: FloorState, path: string): void {
  const keys = new Set<string>();
  for (const attempt of Object.values(state.attempts)) {
    for (const premise of Object.values(attempt.premises)) {
      if (premise.kind === "entity" && premisePath("entity", premise.key).path === path) keys.add(premise.key);
    }
    for (const op of attempt.ops) {
      if (op.path === path) for (const key of [...op.altered, ...op.added, ...op.removed]) keys.add(key);
    }
  }
  for (const landing of Object.values(state.landings)) {
    if (landing.digest === true) continue;
    for (const write of landing.writes) {
      if (write.kind === "entity" && premisePath("entity", write.key).path === path) keys.add(write.key);
    }
  }
  fileOf(state, path).keys = [...keys];
}

/** Take an attempt out of every in-flight mark: file readers and writers, directory readers. */
function unmarkInFlight(state: FloorState, attemptId: string): void {
  for (const file of Object.values(state.files)) {
    dropOnce(file.readers, attemptId);
    dropOnce(file.writers, attemptId);
  }
  for (const dir of Object.values(state.dirs)) dropOnce(dir.readers, attemptId);
}

// ---- The rail order of the Working tab (CO9) ----

const TOP_STATES = new Set(["going_around", "needs_confirm"]);

/**
 * Rebuilds `working_order`: attempts whose intent has a member in `going_around` or `needs_confirm`
 * form the top group in the order they entered it (the whole group moves as one for a race intent);
 * the rest follows newest intent first. Sorts are stable, so an attempt that enters and leaves the
 * top group returns to its group's place without moving any other card.
 */
function syncWorkingOrder(state: FloorState): void {
  // CO9: intents with an attempt in a top state come first, in the order the earliest of them
  // entered it; the rest follow, newest intent first. All of an intent's attempts move as one group.
  const topGroupTs = new Map<string, number>();
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.top_ts === null) continue;
    topGroupTs.set(attempt.intent_id, Math.min(topGroupTs.get(attempt.intent_id) ?? attempt.top_ts, attempt.top_ts));
  }
  const kept: Array<{ id: string; intent_id: string }> = [];
  for (const id of state.working_order) {
    const attempt = state.attempts[id];
    if (attempt !== undefined) kept.push({ id, intent_id: attempt.intent_id });
  }
  const top = kept.filter((entry) => topGroupTs.has(entry.intent_id));
  const rest = kept.filter((entry) => !topGroupTs.has(entry.intent_id));
  top.sort((a, b) => (topGroupTs.get(a.intent_id) ?? 0) - (topGroupTs.get(b.intent_id) ?? 0));
  const rank = new Map<string, number>(Object.keys(state.intents).map((id, index) => [id, index]));
  rest.sort((a, b) => (rank.get(b.intent_id) ?? 0) - (rank.get(a.intent_id) ?? 0));
  state.working_order = [...top, ...rest].map((entry) => entry.id);
}

// ---- Per-event handlers (03-floor 4.3, one block per row) ----

function onPoolState(state: FloorState, event: Extract<PoolEvent, { type: "pool.state" }>): void {
  const { pool } = state;
  const rebuild = event.epoch > pool.epoch && pool.epoch !== 0;
  pool.state = event.state;
  pool.reason = event.reason;
  pool.epoch = event.epoch;
  pool.synthetic = event.synthetic;
  pool.summary_only = event.summary_only;
  pool.head_seq = event.head_seq;
  pool.head_commit = event.head_commit;
  pool.landed_seq = event.landed_seq;
  pool.landed_commit = event.landed_commit;
  pool.real_agents = event.real_agents;
  pool.max_real_agents = event.max_real_agents;
  pool.remote = event.remote;
  pool.plain_remote = event.plain_remote;
  // IR8: `null` is an imported pool's answer and is kept; only a stream from before IR8, which
  // carries no `app` at all, means a seed pool.
  pool.app = event.app === undefined ? "tidepool" : event.app;
  pool.source = event.source ?? null;
  pool.rebuild = event.rebuild;
  pool.unwitnessed = event.unwitnessed;
  if (rebuild) {
    // A rebuild from Artifacts raised the epoch (RB5): every open card is closed as stale by system.
    for (const cardId of [...state.open_cards]) {
      closeCard(state, cardId, "stale", "system", null, null, event.ts);
    }
  }
}

function onPoolFiles(state: FloorState, event: Extract<PoolEvent, { type: "pool.files" }>): void {
  const listed = new Map(event.files.map((file) => [file.path, file.tier]));
  for (const file of Object.values(state.files)) {
    const tier = listed.get(file.path);
    if (tier === undefined) {
      file.exists = false;
      file.tier = null;
    } else {
      file.exists = true;
      file.tier = tier;
      listed.delete(file.path);
    }
  }
  for (const [path, tier] of listed) {
    const file = fileOf(state, path);
    file.exists = true;
    file.tier = tier;
  }
}

function onPoolPaused(state: FloorState, event: Extract<PoolEvent, { type: "pool.paused" }>): void {
  state.pool.state = "paused";
  state.pool.reason = event.reason;
}

function onTrunkError(state: FloorState, _event: Extract<PoolEvent, { type: "trunk.error" }>): void {
  state.trunk_errors += 1;
}

function onIntentCreated(state: FloorState, event: Extract<PoolEvent, { type: "intent.created" }>): void {
  state.intents[event.intent_id] = {
    id: event.intent_id,
    text: event.text,
    requester: event.requester,
    race: event.race,
    prewritten: event.prewritten,
    state: "open",
    created_ts: event.ts,
    attempt_ids: [],
  };
  state.first_intent_ts ??= event.ts;
}

function onIntentState(state: FloorState, event: Extract<PoolEvent, { type: "intent.state" }>): void {
  const intent = state.intents[event.intent_id];
  if (intent !== undefined) intent.state = event.state;
}

function newAttempt(event: Extract<PoolEvent, { type: "attempt.opened" }>): AttemptView {
  return {
    id: event.attempt_id,
    intent_id: event.intent_id,
    change_id: event.change_id,
    agent: event.agent,
    model: event.model,
    race: event.race,
    state: "opened",
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
    revision: 1,
    reopened_by: null,
    model_changed: false,
    opened_ts: event.ts,
    last_event_ts: event.ts,
    step: null,
    steps: 0,
    premises: {},
    ops: [],
    heads_ups: {},
    submit: null,
    repair_open_ts: null,
    skipped: null,
    card_id: null,
    approved_ts: null,
    landed_seq: null,
    cost_usd: null,
    top_ts: null,
  };
}

function onAttemptOpened(state: FloorState, event: Extract<PoolEvent, { type: "attempt.opened" }>): void {
  state.attempts[event.attempt_id] = newAttempt(event);
  const intent = state.intents[event.intent_id];
  if (intent !== undefined) addOnce(intent.attempt_ids, event.attempt_id);
  if (event.agent === "synthetic") state.pool.synthetic = true; // EM1a: the flag only ever rises
  addOnce(state.working_order, event.attempt_id);
  syncWorkingOrder(state);
}

function onAttemptState(state: FloorState, event: Extract<PoolEvent, { type: "attempt.state" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  const wasGoingAround = attempt.state === "going_around";
  const wasStored = attempt.go_arounds;
  attempt.state = event.to;
  if (event.to === "stopped") attempt.stop_reason = event.reason;
  attempt.go_arounds = event.go_arounds;
  attempt.pull_backs = event.pull_backs;
  attempt.right_of_way = event.right_of_way;
  attempt.skipped = null;
  attempt.last_event_ts = event.ts;
  if (TOP_STATES.has(event.to)) {
    if (!TOP_STATES.has(event.from)) attempt.top_ts = event.ts;
  } else {
    attempt.top_ts = null;
  }
  // CO9: stopped, accepted and landed attempts leave the Working rail.
  if (event.to === "stopped" || event.to === "landed" || event.to === "accepted") {
    dropOnce(state.working_order, event.attempt_id);
  }
  // GA1: a new go-around in going_around has from = to and a higher count (T10a); a repair that joins
  // the current go-around keeps the count (T10); "Try again" resets it and starts one (T21).
  if (event.to === "going_around" && (event.go_arounds > wasStored || event.from === "stopped")) {
    state.counters.go_arounds += 1;
  }
  // 14.4: leaving going_around closes the open go-around log entries — unless the attempt stopped.
  if (wasGoingAround && event.to !== "going_around") {
    for (const entry of state.go_around_log) {
      if (entry.attempt_id === event.attempt_id && entry.end_ts === null) {
        entry.end_ts = event.to === "stopped" ? -1 : event.ts;
      }
    }
  }
  if (event.to === "stopped" || event.to === "landed") unmarkInFlight(state, event.attempt_id);
  syncWorkingOrder(state);
}

function onAttemptReopened(state: FloorState, event: Extract<PoolEvent, { type: "attempt.reopened" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.revision = event.revision;
  attempt.reopened_by = event.cause;
  attempt.model_changed = event.model_changed;
  attempt.stop_reason = null;
  attempt.last_event_ts = event.ts;
  if (event.cause === "undo" || event.cause === "revert") {
    // The landed attempt's premises come back from its LandingView; every light is `holds` again
    // until it is judged anew. `ops` is not part of `LandingView` (see the gap note in the report).
    const landing = attempt.landed_seq === null ? null : state.landings[attempt.landed_seq];
    if (landing !== null && landing !== undefined && landing.digest !== true) {
      attempt.premises = {};
      for (const premise of landing.premises) {
        attempt.premises[premiseId(premise.kind, premise.key)] = {
          ...premise,
          light: "holds",
          judgment: null,
        };
        if (premise.read) markReader(state, event.attempt_id, premise.kind, premise.key);
      }
    }
    attempt.landed_seq = null;
  }
  addOnce(state.working_order, event.attempt_id);
  syncWorkingOrder(state);
}

function onAttemptStep(state: FloorState, event: Extract<PoolEvent, { type: "attempt.step" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  if (state.pool.summary_only) return; // FE4: no steps are kept for a summary_only pool
  attempt.step = {
    n: event.step,
    tool: event.tool,
    target: event.target,
    ok: event.ok,
    error: event.error,
    ts: event.ts,
  };
  attempt.steps = event.step;
  if (event.cost_usd !== null) attempt.cost_usd = (attempt.cost_usd ?? 0) + event.cost_usd;
}

function onAttemptRepo(state: FloorState, event: Extract<PoolEvent, { type: "attempt.repo" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt !== undefined) attempt.last_event_ts = event.ts;
  if (event.ok) state.repos.ok += 1;
  else state.repos.failed += 1;
  state.repos.first_ts = state.repos.first_ts === null ? event.ts : Math.min(state.repos.first_ts, event.ts);
  state.repos.last_ts = state.repos.last_ts === null ? event.ts : Math.max(state.repos.last_ts, event.ts);
}

function premiseFromRef(ref: PremiseRef): PremiseView {
  return {
    kind: ref.kind,
    key: ref.key,
    hash: ref.hash,
    read: ref.read,
    edit: ref.edit,
    derived: ref.derived,
    light: "holds",
    judgment: null,
  };
}

function onPremiseRecorded(state: FloorState, event: Extract<PoolEvent, { type: "premise.recorded" }>): void {
  if (state.pool.summary_only) return; // EV6
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  const id = premiseId(event.premise.kind, event.premise.key);
  const existing = attempt.premises[id];
  if (existing === undefined) {
    attempt.premises[id] = premiseFromRef(event.premise);
  } else {
    existing.hash = event.premise.hash;
    existing.read = event.premise.read;
    existing.edit = event.premise.edit;
    existing.derived = event.premise.derived;
  }
  if (event.premise.read) markReader(state, event.attempt_id, event.premise.kind, event.premise.key);
  else unmarkReader(state, event.attempt_id, event.premise.kind, event.premise.key);
  if (event.premise.kind === "entity") {
    const { path } = premisePath("entity", event.premise.key);
    if (path !== null) {
      fileOf(state, path).exists = true;
      recomputeKeys(state, path);
    }
  }
  if (event.premise.kind === "file") {
    fileOf(state, event.premise.key).exists = event.premise.hash !== ABSENT;
  }
}

function onPremiseRemoved(state: FloorState, event: Extract<PoolEvent, { type: "premise.removed" }>): void {
  if (state.pool.summary_only) return; // EV6
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  const id = premiseId(event.kind, event.key);
  const premise = attempt.premises[id];
  if (premise !== undefined && premise.read) unmarkReader(state, event.attempt_id, event.kind, event.key);
  delete attempt.premises[id];
}

function onPremiseJudged(state: FloorState, event: Extract<PoolEvent, { type: "premise.judged" }>): void {
  if (state.pool.summary_only) return; // FE4: no premise exists to hold the judgment
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  const id = premiseId(event.kind, event.key);
  const premise = (attempt.premises[id] ??= {
    kind: event.kind,
    key: event.key,
    hash: null,
    read: false,
    edit: false,
    derived: false,
    light: "holds",
    judgment: null,
  });
  premise.judgment = {
    rule: event.rule,
    reason: event.reason,
    result: event.result,
    cause_seq: event.cause_seq,
    clef: event.clef,
  };
  premise.light = lightOf(event.result, event.rule);
}

/** The light a judgment or a heads-up item gives its premise (03-floor 4.3). */
function lightOf(result: "holds" | "confirm" | "repair" | "pending" | null, rule: string): PremiseView["light"] {
  if (result === "repair") return "changed";
  if (result === "confirm") return rule === "B1" ? "blind_spot" : "confirm";
  if (result === "pending" || result === null) return "checking";
  return "holds";
}

function onOpRecorded(state: FloorState, event: Extract<PoolEvent, { type: "op.recorded" }>): void {
  if (state.pool.summary_only) return; // EV6
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  attempt.ops.push({
    op_seq: event.op_seq,
    op: event.op,
    path: event.path,
    dropped: false,
    altered: event.altered,
    added: event.added,
    removed: event.removed,
  });
  const file = fileOf(state, event.path);
  file.exists = true;
  addOnce(file.writers, event.attempt_id);
  recomputeKeys(state, event.path);
}

function onOpDropped(state: FloorState, event: Extract<PoolEvent, { type: "op.dropped" }>): void {
  if (state.pool.summary_only) return; // EV6
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  for (const op of attempt.ops) {
    if (event.op_seqs.includes(op.op_seq)) op.dropped = true;
  }
  const remains = attempt.ops.some((op) => op.path === event.path && !op.dropped);
  const file = state.files[event.path];
  if (!remains && file !== undefined) dropOnce(file.writers, event.attempt_id);
}

function onHeadsUpSent(state: FloorState, event: Extract<PoolEvent, { type: "headsup.sent" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  const view: HeadsUpView = {
    hn: event.hn,
    result: event.result,
    wake: event.wake,
    ts: event.ts,
    cause: event.cause,
    go_around: event.go_around,
    keys: event.keys,
    items: state.pool.summary_only ? null : event.items,
    dropped_ops: event.dropped_ops,
    resolved: null,
  };
  // 14.3 counts a heads-up at send: it must be booked before FE4's one-entry memory.
  const sent = (state.heads_sent[event.attempt_id] ??= { repair: 0, confirm: 0 });
  if (event.result === "repair") {
    sent.repair += 1;
    if (attempt.agent === "real" && attempt.repair_open_ts === null) {
      attempt.repair_open_ts = event.ts; // 14.7
    }
  } else if (event.result === "confirm") {
    sent.confirm += 1;
  }
  if (state.pool.summary_only) {
    // FE4: only the last heads-up is kept, without items.
    attempt.heads_ups = { [event.hn]: view };
    return;
  }
  attempt.heads_ups[event.hn] = view;
  if (event.items !== null) {
    for (const item of event.items) {
      if (item.premise.kind === "check") continue;
      const id = premiseId(item.premise.kind, item.premise.key);
      const premise = (attempt.premises[id] ??= {
        kind: item.premise.kind,
        key: item.premise.key,
        hash: null,
        read: false,
        edit: false,
        derived: false,
        light: "holds",
        judgment: null,
      });
      premise.light = lightOf(item.result, item.rule);
    }
  }
}

function onHeadsUpResolved(state: FloorState, event: Extract<PoolEvent, { type: "headsup.resolved" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  const headsUp = attempt.heads_ups[event.hn];
  if (headsUp !== undefined) {
    headsUp.resolved = { statement: event.statement, changed: event.changed, ts: event.ts };
  }
  if (event.result === "repair" && event.go_around !== null) {
    // HU12 feeds metric 14.4: one entry per (attempt, go-around); `changed` accumulates. A pair
    // is counted once, when the attempt next leaves going_around — a resolution arriving after
    // that count is history for the pair, not a second go-around.
    const entries = state.go_around_log.filter(
      (log) => log.attempt_id === event.attempt_id && log.go_around === event.go_around,
    );
    const entry = entries.find((log) => log.end_ts === null);
    if (entry !== undefined) {
      entry.changed ||= event.changed;
    } else if (entries.length === 0) {
      state.go_around_log.push({
        attempt_id: event.attempt_id,
        go_around: event.go_around,
        changed: event.changed,
        end_ts: null,
      });
    }
  }
  if (state.pool.summary_only) return;
  // Every premise the heads-up named whose light was a warning returns to `holds`; `checking` stays.
  if (headsUp === undefined) return;
  for (const key of headsUp.keys) {
    if (key.kind === "check") continue;
    const premise = attempt.premises[premiseId(key.kind, key.key)];
    if (premise !== undefined && premise.light !== "checking") premise.light = "holds";
  }
}

function onSubmitResult(state: FloorState, event: Extract<PoolEvent, { type: "submit.result" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt === undefined) return;
  attempt.last_event_ts = event.ts;
  if (event.duplicate) return;
  attempt.submit = {
    submit_id: event.submit_id,
    status: event.status,
    tier: event.tier,
    checks: event.checks,
    ts: event.ts,
  };
  // 14.2: only an answered submit counts; `accepted`/`landed` reports must not move the base.
  if (event.status === "validated" || event.status === "submitted" || event.status === "held") {
    state.submit_answers[event.attempt_id] = event.ts;
  }
  // 14.7: the first answered submit ends the open go-around's repair clock.
  if (
    attempt.repair_open_ts !== null &&
    (event.status === "validated" || event.status === "submitted" || event.status === "held")
  ) {
    state.repair_ms.push(event.ts - attempt.repair_open_ts);
    attempt.repair_open_ts = null;
  }
}

function closeCard(
  state: FloorState,
  cardId: string,
  action: Extract<PoolEvent, { type: "card.closed" }>["action"],
  by: "owner" | "system",
  attemptId: string | null,
  reason: string | null,
  ts: number,
): void {
  const card = state.cards[cardId];
  if (card === undefined) return;
  card.open = false;
  card.closed = { action, by, attempt_id: attemptId, reason, ts };
  dropOnce(state.open_cards, cardId);
  if (action === "land" || action === "land_now" || action === "choose") {
    const target = action === "choose" ? attemptId : (attemptId ?? card.card.attempt_ids[0]);
    const attempt = target === null || target === undefined ? undefined : state.attempts[target];
    if (attempt !== undefined) attempt.approved_ts = ts;
  }
}

function onCardOpened(state: FloorState, event: Extract<PoolEvent, { type: "card.opened" }>): void {
  const view: CardView = { card: event.card, open: true, opened_ts: event.ts, closed: null };
  state.cards[event.card.card_id] = view;
  addOnce(state.open_cards, event.card.card_id);
  for (const attemptId of event.card.attempt_ids) {
    const attempt = state.attempts[attemptId];
    if (attempt !== undefined) attempt.card_id = event.card.card_id;
  }
}

function onCardUpdated(state: FloorState, event: Extract<PoolEvent, { type: "card.updated" }>): void {
  const view = state.cards[event.card.card_id];
  if (view !== undefined) view.card = event.card;
}

function onCardClosed(state: FloorState, event: Extract<PoolEvent, { type: "card.closed" }>): void {
  closeCard(state, event.card_id, event.action, event.by, event.attempt_id, event.reason, event.ts);
}

function onLandingAccepted(state: FloorState, event: Extract<PoolEvent, { type: "landing.accepted" }>): void {
  const attempt = event.attempt_id === null ? undefined : state.attempts[event.attempt_id];
  const card = attempt?.card_id === null || attempt?.card_id === undefined ? undefined : state.cards[attempt.card_id];
  const closed = card?.closed;
  const approved =
    closed !== null && closed !== undefined && closed.by === "owner" && card !== undefined
      ? closed.action === "land" || closed.action === "land_now" || closed.action === "choose"
        ? { by: "owner" as const, option: closed.action, card_reason: card.card.reason, ts: closed.ts }
        : null
      : null;
  const landing: LandingView = {
    seq: event.seq,
    kind: event.kind,
    batch_id: event.batch_id,
    attempt_id: event.attempt_id,
    change_id: event.change_id,
    intent_id: event.intent_id,
    request_id: event.request_id,
    paths: event.paths,
    writes: event.writes,
    accepted_ts: event.ts,
    landed: null,
    undone_by: null,
    premises: attempt === undefined ? [] : Object.values(attempt.premises).map((premise) => ({ ...premise })),
    go_arounds:
      attempt === undefined
        ? []
        : Object.values(attempt.heads_ups)
            .filter((headsUp) => headsUp.result === "repair" && headsUp.resolved !== null)
            .sort((a, b) => a.hn - b.hn),
    confirms:
      attempt === undefined
        ? []
        : Object.values(attempt.heads_ups)
            .filter((headsUp) => headsUp.result === "confirm" && headsUp.resolved !== null)
            .sort((a, b) => a.hn - b.hn),
    checks: attempt?.submit?.checks ?? [],
    tier: attempt?.submit?.tier ?? null,
    approved,
    risk: card?.card.risk ?? null,
    note: null,
  };
  state.landings[event.seq] = landing;
  // 14.2/14.3 frozen at acceptance: the attempt's last answered submit and its received
  // heads-ups. A landing whose attempt the stream never showed keeps null/zero.
  state.landing_facts[event.seq] = {
    submit_ts: state.submit_answers[event.attempt_id ?? ""] ?? null,
    repair: state.heads_sent[event.attempt_id ?? ""]?.repair ?? 0,
    confirm: state.heads_sent[event.attempt_id ?? ""]?.confirm ?? 0,
  };
  state.landed_order.unshift(event.seq);
  if (attempt !== undefined) {
    attempt.landed_seq = event.seq;
    attempt.last_event_ts = event.ts;
  }
  state.pool.head_seq = event.seq;
  if (state.push === null) {
    state.push = { batch_id: event.batch_id, first_accepted_ts: event.ts, tries: 0, error: null, next_try_ts: null };
  }
  trimLandings(state);
}

function digestOf(landing: LandingView): LandingDigest {
  return {
    digest: true,
    seq: landing.seq,
    kind: landing.kind,
    batch_id: landing.batch_id,
    attempt_id: landing.attempt_id,
    change_id: landing.change_id,
    intent_id: landing.intent_id,
    request_id: landing.request_id,
    paths: landing.paths,
    premise_keys: landing.premises.map((premise) => ({ kind: premise.kind, key: premise.key })),
    accepted_ts: landing.accepted_ts,
    landed_ts: landing.landed?.ts ?? null,
    commit: landing.landed?.commit ?? null,
    tree: landing.landed?.tree ?? null,
    undone_by: landing.undone_by,
  };
}

/** FS1: the newest FLOOR_KEEP_LANDINGS landings stay in full; the older ones become digest lines. */
function trimLandings(state: FloorState): void {
  const full = Object.values(state.landings).filter((entry) => entry.digest !== true);
  let overflow = full.length - FLOOR_KEEP_LANDINGS;
  if (overflow <= 0) return;
  for (const seq of [...state.landed_order].reverse()) {
    if (overflow <= 0) break;
    const entry = state.landings[seq];
    if (entry !== undefined && entry.digest !== true) {
      state.landings[seq] = digestOf(entry);
      delete state.landing_facts[seq];
      overflow -= 1;
    }
  }
}

function onLandingLanded(state: FloorState, event: Extract<PoolEvent, { type: "landing.landed" }>): void {
  const entry: LandingEntry | undefined = state.landings[event.seq];
  if (entry === undefined) {
    // A landing.landed with no landing.accepted keeps the stream total (FE1): a digest row.
    state.landings[event.seq] = {
      digest: true,
      seq: event.seq,
      kind: "change",
      batch_id: event.batch_id,
      attempt_id: null,
      change_id: "",
      intent_id: null,
      request_id: null,
      paths: [],
      premise_keys: [],
      accepted_ts: event.ts,
      landed_ts: event.ts,
      commit: event.commit,
      tree: event.tree,
      undone_by: null,
    };
    state.landed_order.unshift(event.seq);
  } else if (entry.digest === true) {
    entry.landed_ts = event.ts;
    entry.commit = event.commit;
    entry.tree = event.tree;
    if (entry.kind === "change") state.counters.landed_changes += 1;
  } else {
    entry.landed = {
      commit: event.commit,
      tree: event.tree,
      note_id: event.note,
      ts: event.ts,
      time_to_land_ms: event.time_to_land_ms,
    };
    entry.note = parseNote(event.note_json);
    if (entry.kind === "change") state.counters.landed_changes += 1;
    for (const path of entry.paths) {
      const file = fileOf(state, path);
      file.exists = true;
      file.last_landed_seq = event.seq;
    }
    for (const write of entry.writes) {
      if (write.kind === "file") {
        fileOf(state, write.key).exists = write.new !== ABSENT;
      }
      if (write.kind === "entity") {
        const { path } = premisePath("entity", write.key);
        if (path !== null) recomputeKeys(state, path);
      }
    }
    if (entry.kind === "undo" || entry.kind === "revert") {
      const plan = entry.request_id === null ? undefined : state.undo[entry.request_id];
      if (plan !== undefined) {
        plan.landing_seq = event.seq;
        for (const seq of plan.reverted) {
          const reverted = state.landings[seq];
          if (reverted !== undefined) reverted.undone_by = event.seq;
        }
      }
    }
  }
  state.pool.landed_seq = event.seq;
  state.pool.landed_commit = event.commit;
  if (entry !== undefined && entry.attempt_id !== null) {
    // CO12: the attempt card moves to the Landed tab.
    dropOnce(state.working_order, entry.attempt_id);
    syncWorkingOrder(state);
  }
}

function onBatchPushed(state: FloorState, event: Extract<PoolEvent, { type: "batch.pushed" }>): void {
  state.push = null;
  state.last_push = {
    batch_id: event.batch_id,
    landings: event.last_seq - event.first_seq + 1,
    tries: event.tries,
    ms: event.ms,
  };
}

function onPushRetry(state: FloorState, event: Extract<PoolEvent, { type: "push.retry" }>): void {
  if (state.push === null) {
    state.push = {
      batch_id: event.batch_id,
      first_accepted_ts: event.ts,
      tries: event.tries,
      error: event.error,
      next_try_ts: null,
    };
  }
  state.push.tries = event.tries;
  state.push.error = event.error;
  state.push.next_try_ts = event.ts + event.next_try_ms;
}

function onTickSkipped(state: FloorState, event: Extract<PoolEvent, { type: "tick.skipped" }>): void {
  const attempt = state.attempts[event.attempt_id];
  if (attempt !== undefined) {
    attempt.skipped = { why: event.why, behind: event.behind };
    attempt.last_event_ts = event.ts;
  }
}

function onUndoPlanned(state: FloorState, event: Extract<PoolEvent, { type: "undo.planned" }>): void {
  state.undo[event.request_id] = {
    request_id: event.request_id,
    cause: event.cause,
    target_seq: event.target_seq,
    reverted: event.reverted,
    reopened: event.reopened,
    kept_readers: event.kept_readers,
    landing_seq: null,
  };
}

function onUndoRefused(_state: FloorState, _event: Extract<PoolEvent, { type: "undo.refused" }>): void {
  // Nothing new on screen (03-floor 4.3): the requesting browser already shows the refusal.
}

function onPlainUpdated(state: FloorState, event: Extract<PoolEvent, { type: "plain.updated" }>): void {
  state.plain = {
    commit: event.commit,
    tree: event.tree,
    through_seq: event.through_seq,
    skipped: event.skipped,
    interrupted: event.interrupted,
  };
}

function onGreenVerified(state: FloorState, event: Extract<PoolEvent, { type: "green.verified" }>): void {
  state.green.runtime = event.runtime;
  state.green.last = {
    seq: event.seq,
    ok: event.ok,
    confirmed: event.confirmed,
    failed: event.checks
      .filter((check) => !check.ok)
      .map((check) => ({ name: check.name, code: check.code ?? `${check.name}:failed` })),
  };
}

function onGreenAdvanced(state: FloorState, event: Extract<PoolEvent, { type: "green.advanced" }>): void {
  state.green.seq = event.seq;
  state.green.commit = event.commit;
}

function onMetrics(state: FloorState, event: Extract<PoolEvent, { type: "metrics" }>): void {
  state.metrics = event;
  state.metrics_history.push({
    ts: event.ts,
    landings_per_second: event.landings_per_second,
    go_around_rate: event.go_around_rate,
  });
  const newest = state.metrics_history.reduce((max, entry) => Math.max(max, entry.ts), 0);
  state.metrics_history = state.metrics_history.filter((entry) => entry.ts >= newest - 60_000);
}

function onLimits(state: FloorState, event: Extract<PoolEvent, { type: "limits" }>): void {
  state.limits = {
    spend_usd: event.spend_usd,
    reserved_usd: event.reserved_usd,
    cap_usd: event.cap_usd,
    killed: event.killed,
    refusing: event.refusing,
    ts: event.ts,
    models: event.models,
  };
}

function onSwarmState(state: FloorState, event: Extract<PoolEvent, { type: "swarm.state" }>): void {
  state.swarm = {
    running: event.running,
    agents: event.agents,
    collision_dial: event.collision_dial,
    pools: event.pools,
    ever_ran: (state.swarm?.ever_ran ?? false) || event.running,
  };
}

// ---- The function itself (EV5, FE1, FE2) ----

/**
 * Applies one `PoolEvent` to `state` per 03-floor 4.3 and returns `state`. Every event sets `n` and
 * `ts` (the largest `ts` seen, per RY13); a type the reducer does not know counts in
 * `unknown_events` and changes nothing else (FE1). In a `summary_only` pool the rows EV6 names are
 * no-ops beyond `n` and `ts` (FE4).
 */
export function reduce(state: FloorState, event: PoolEvent): FloorState {
  state.n = event.n;
  state.ts = Math.max(state.ts, event.ts);
  if (state.pool.id === "") state.pool.id = event.pool;
  switch (event.type) {
    case "pool.state":
      onPoolState(state, event);
      break;
    case "pool.files":
      onPoolFiles(state, event);
      break;
    case "pool.paused":
      onPoolPaused(state, event);
      break;
    case "trunk.error":
      onTrunkError(state, event);
      break;
    case "intent.created":
      onIntentCreated(state, event);
      break;
    case "intent.state":
      onIntentState(state, event);
      break;
    case "attempt.opened":
      onAttemptOpened(state, event);
      break;
    case "attempt.state":
      onAttemptState(state, event);
      break;
    case "attempt.reopened":
      onAttemptReopened(state, event);
      break;
    case "attempt.step":
      onAttemptStep(state, event);
      break;
    case "attempt.repo":
      onAttemptRepo(state, event);
      break;
    case "premise.recorded":
      onPremiseRecorded(state, event);
      break;
    case "premise.removed":
      onPremiseRemoved(state, event);
      break;
    case "premise.judged":
      onPremiseJudged(state, event);
      break;
    case "op.recorded":
      onOpRecorded(state, event);
      break;
    case "op.dropped":
      onOpDropped(state, event);
      break;
    case "headsup.sent":
      onHeadsUpSent(state, event);
      break;
    case "headsup.resolved":
      onHeadsUpResolved(state, event);
      break;
    case "submit.result":
      onSubmitResult(state, event);
      break;
    case "card.opened":
      onCardOpened(state, event);
      break;
    case "card.updated":
      onCardUpdated(state, event);
      break;
    case "card.closed":
      onCardClosed(state, event);
      break;
    case "landing.accepted":
      onLandingAccepted(state, event);
      break;
    case "landing.landed":
      onLandingLanded(state, event);
      break;
    case "batch.pushed":
      onBatchPushed(state, event);
      break;
    case "push.retry":
      onPushRetry(state, event);
      break;
    case "tick.skipped":
      onTickSkipped(state, event);
      break;
    case "undo.planned":
      onUndoPlanned(state, event);
      break;
    case "undo.refused":
      onUndoRefused(state, event);
      break;
    case "plain.updated":
      onPlainUpdated(state, event);
      break;
    case "green.verified":
      onGreenVerified(state, event);
      break;
    case "green.advanced":
      onGreenAdvanced(state, event);
      break;
    case "metrics":
      onMetrics(state, event);
      break;
    case "limits":
      onLimits(state, event);
      break;
    case "swarm.state":
      onSwarmState(state, event);
      break;
    default:
      state.unknown_events += 1;
      break;
  }
  return state;
}

/** The event types the reducer maps, for callers that want the handled set (AC2). */
export const HANDLED_TYPES: readonly string[] = EVENT_TYPES;
