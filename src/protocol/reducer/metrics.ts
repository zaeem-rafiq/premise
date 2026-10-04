// `computeMetrics(state, nowTs, windowMs)`: the `metrics` event body of EM5 — the numbers of
// 01-core 14 the shared reducer computes over the stream. Called by the Floor Durable Object every
// METRICS_EVERY_MS; the Floor UI displays the emitted event and never recomputes it.
//
// What it cannot see: `tick_cpu_ms` — no event of 12.1 carries tick CPU time, so both percentiles
// are null until the protocol grows a carrier (14.6 says Trunk reports it; the stream has no field).
// `escape_rate` is null while the pool never saw `green.advanced` (14.5's "no green line" case: the
// `features` flag of FJ1 is not part of the stream, so `green.seq === null` is the reducer's proxy).

import { METRICS_WINDOW_MS } from "../constants.ts";
import type { PoolEvent } from "../events.ts";
import type { FloorState, LandingView } from "./state.ts";

export type MetricsBody = Omit<Extract<PoolEvent, { type: "metrics" }>, "n" | "t" | "ts" | "pool" | "src" | "type">;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * The `metrics` event body for `state` at stream time `nowTs`, over the trailing window of
 * `windowMs` (`METRICS_WINDOW_MS` when not given). Window membership uses `ts`, the source's commit
 * time (EV5).
 */
export function computeMetrics(state: FloorState, nowTs: number, windowMs: number = METRICS_WINDOW_MS): MetricsBody {
  const from = nowTs - windowMs;

  // The window's confirmed landings of kind `change` (14.1 to 14.3, 14.5).
  const landed: LandingView[] = [];
  for (const entry of Object.values(state.landings)) {
    if (entry.digest === true || entry.kind !== "change" || entry.landed === null) continue;
    if (entry.landed.ts > from && entry.landed.ts <= nowTs) landed.push(entry);
  }

  // 14.1: landings per second over the window.
  const landings_per_second = landed.length / (windowMs / 1000);

  // 14.2: for one landing, ts(landing.landed) − ts(last submit.result of the attempt before
  // acceptance); "time held" is the owner wait on a card inside it (approved − submit).
  const toLand: number[] = [];
  const held: number[] = [];
  for (const landing of landed) {
    const attempt = landing.attempt_id === null ? undefined : state.attempts[landing.attempt_id];
    const submitTs = attempt?.submit?.ts;
    if (submitTs !== undefined && landing.landed !== null) toLand.push(landing.landed.ts - submitTs);
    if (submitTs !== undefined && landing.approved !== null) held.push(landing.approved.ts - submitTs);
  }
  toLand.sort((a, b) => a - b);
  held.sort((a, b) => a - b);

  // 14.3: the landing counts when its attempt received a repair heads-up before acceptance (the
  // note's go_arounds), and a confirm heads-up for the confirm rate — frozen into the LandingView.
  const withGoAround = landed.filter((landing) => landing.go_arounds.length > 0).length;
  const go_around_rate = landed.length === 0 ? null : withGoAround / landed.length;

  // 14.4: go-arounds ended in the window (an attempt.state left going_around for a non-stopped
  // state); a false abort is one where no headsup.resolved of its pair carried changed: true.
  const ended = state.go_around_log.filter(
    (entry) => entry.end_ts !== null && entry.end_ts > 0 && entry.end_ts > from && entry.end_ts <= nowTs,
  );
  const falseAbort = ended.filter((entry) => !entry.changed).length;
  const false_abort_rate = ended.length === 0 ? null : falseAbort / ended.length;

  // 14.5: window landings of kind change reverted by the green line (`undone_by` a revert landing).
  let escape_rate: number | null = null;
  if (state.green.seq !== null) {
    const escaped = landed.filter((landing) => {
      if (landing.undone_by === null) return false;
      const undo = state.landings[landing.undone_by];
      return undo !== undefined && undo.kind === "revert";
    }).length;
    escape_rate = landed.length === 0 ? 0 : escaped / landed.length;
  }

  // 14.6: attempts in `validated` the last tick skipped for right_of_way; an attempt on a card waits
  // for a person, not for a change, and is not counted. `push_backlog`: attempts in `validated`
  // while an outbox row is pending.
  let waiting_behind = 0;
  let validated = 0;
  for (const attempt of Object.values(state.attempts)) {
    // An attempt that was already accepted is in the outbox, not waiting for a change.
    if (attempt.state !== "validated" || attempt.landed_seq !== null) continue;
    validated += 1;
    if (attempt.skipped?.why === "right_of_way" && attempt.card_id === null) waiting_behind += 1;
  }
  const push_backlog = state.push === null ? 0 : validated;

  return {
    window_ms: windowMs,
    landings_per_second,
    time_to_land_ms: { p50: percentile(toLand, 50), p99: percentile(toLand, 99) },
    time_held_ms: { p50: percentile(held, 50), p99: percentile(held, 99) },
    go_around_rate,
    false_abort_rate,
    escape_rate,
    waiting_behind,
    push_backlog,
    tick_cpu_ms: { p50: null, p99: null },
  };
}
