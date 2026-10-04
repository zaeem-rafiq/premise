// src/worker/agent/inbox.ts — the Agent's inbox over SQLite (HU4, HU6, SP5).
//
// receive stores pushed and response-carried heads-ups, de-duplicated by hn.
// nextShow wraps the pure inboxNext against the table's hns; markShown records
// the transcript step that carried each heads-up; acknowledge lists the
// confirm/repair numbers a submit may resolve (CK1); prune drops rows the
// spec says need not be kept.

import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Sql } from "../../protocol/ports.ts";
import { inboxNext, type InboxNext } from "../../core/agent/inbox.ts";
import {
  inboxBodies,
  inboxDeleteBelow,
  inboxDeleteHns,
  inboxHns,
  inboxMarkShown,
  inboxPut,
  inboxRows,
  opDelete,
} from "../../core/agent/store.ts";

export function receive(sql: Sql, heads_ups: readonly HeadsUp[], received_at: number): number[] {
  const stored: number[] = [];
  for (const hu of heads_ups) {
    // OP6: dropped operations leave the mirror — register sends current ops.
    for (const d of hu.dropped_ops ?? []) opDelete(sql, d.op_seq);
    if (inboxPut(sql, hu.hn, hu, received_at)) stored.push(hu.hn);
  }
  return stored;
}

export function hns(sql: Sql): number[] {
  return inboxHns(sql);
}

export function bodies(sql: Sql, of: readonly number[]): HeadsUp[] {
  return inboxBodies<HeadsUp>(sql, of);
}

export function next(sql: Sql, shown_hn: number): InboxNext {
  return inboxNext(shown_hn, inboxHns(sql));
}

export function markShown(sql: Sql, shown: readonly number[], step: number): void {
  inboxMarkShown(sql, shown, step);
}

// The heads-up numbers a submit may acknowledge: confirm or repair results
// already shown (hn <= shown_hn) and not yet resolved by an earlier submit
// (hn > acked_hn, TL10).
export function acknowledge(sql: Sql, shown_hn: number, acked_hn: number): number[] {
  const out: number[] = [];
  for (const row of inboxRows(sql)) {
    if (row.hn > shown_hn || row.hn <= acked_hn) continue;
    const hu = JSON.parse(row.body) as HeadsUp;
    if (hu.result === "confirm" || hu.result === "repair") out.push(hu.hn);
  }
  return out;
}

// Resolved confirm/repair rows go once a submit acknowledges them; shown
// `info` rows need no further keep — the transcript already carries them.
export function prune(sql: Sql, acked_hn: number): void {
  inboxDeleteBelow(sql, acked_hn);
  const stale: number[] = [];
  for (const row of inboxRows(sql)) {
    if (row.shown_step === null) continue;
    const hu = JSON.parse(row.body) as HeadsUp;
    if (hu.result === "info") stale.push(row.hn);
  }
  inboxDeleteHns(sql, stale);
}
