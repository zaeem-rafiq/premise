// src/worker/agent/journal.ts — the write-ahead journal (AG1, AG4, AG6).
//
// beginCall writes the single journal row and the matching call timer in one
// transaction; finishCall writes the transcript row (and every mirrored fact
// the caller passes) and deletes both in one transaction. A journaled row
// that outlives the Durable Object's memory is the signal that the call it
// names never completed, so it is sent again with the same call_id (AG4);
// Trunk's TA2 makes the repeat safe.

import type { Sql } from "../../protocol/ports.ts";
import {
  journalDelete,
  journalGet,
  journalPut,
  journalRetry,
  timerDelete,
  timerPut,
  type JournalRow,
} from "../../core/agent/store.ts";

export function beginCall(
  sql: Sql,
  input: { kind: JournalRow["kind"]; call_id: string; request: unknown; started_at: number; deadline_at: number },
): void {
  sql.transaction(() => {
    journalPut(sql, { ...input, tries: 0 });
    timerPut(sql, "call", input.call_id, input.deadline_at);
  });
}

export function journaledCall(sql: Sql): JournalRow | null {
  return journalGet(sql);
}

// A timed-out or recovered call is sent again (TL12): the row keeps its
// request and call_id, tries grows, and the call timer is moved to the new
// deadline — one transaction, so a crash mid-retry keeps the row.
export function retryCall(sql: Sql, call_id: string, deadline_at: number): void {
  sql.transaction(() => {
    journalRetry(sql, deadline_at);
    timerPut(sql, "call", call_id, deadline_at);
  });
}

// finishCall runs `apply` and removes the journal row and call timer in the
// same transaction — AG1's "gone after it". If the isolate dies between
// Trunk's answer and this transaction, the row survives and the call is
// replayed instead.
export function finishCall(sql: Sql, call_id: string, apply: () => void): void {
  sql.transaction(() => {
    apply();
    journalDelete(sql);
    timerDelete(sql, "call", call_id);
  });
}

// abandonCall drops the journal and its timer without a transcript row — used
// when the attempt must stop mid-call (tool_timeout, attempt_closed on retry).
export function abandonCall(sql: Sql, call_id: string): void {
  sql.transaction(() => {
    journalDelete(sql);
    timerDelete(sql, "call", call_id);
  });
}
