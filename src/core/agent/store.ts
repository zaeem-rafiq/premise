// src/core/agent/store.ts — row helpers over the Agent's SQLite store.
//
// These read and write the tables of schema.ts (01-core 3.3, 3.4). They do
// no transaction composition of their own beyond single statements: the
// caller opens sql.transaction when several writes must be atomic (AG1,
// AG5). Values are always passed in; nothing here reads a clock.
//
// Pure: synchronous, no I/O, no Clock, no packages.

import type { Sql } from "../../protocol/ports.ts";
import { AGENT_SCHEMA } from "./schema.ts";

export type JournalRow = {
  kind: "model" | "tool";
  call_id: string;
  request: unknown;
  tries: number;
  started_at: number;
  deadline_at: number;
};

export type InboxRow = {
  hn: number;
  body: string;
  received_at: number;
  shown_step: number | null;
};

export type TimerRow = { kind: string; key: string; due_at: number };

export type TranscriptRow = {
  step: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool: string | null;
  call_id: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  started_at: number;
  ended_at: number | null;
};

export function applySchema(sql: Sql): void {
  for (const ddl of AGENT_SCHEMA) sql.exec(ddl);
}

// -- meta ------------------------------------------------------------------

export function metaGet(sql: Sql, k: string): string | null {
  const rows = sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
  return rows.length === 0 ? null : String(rows[0]?.v);
}

export function metaSet(sql: Sql, k: string, v: string | number): void {
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, String(v));
}

export function metaDelete(sql: Sql, k: string): void {
  sql.exec("DELETE FROM meta WHERE k = ?", k);
}

export function metaAll(sql: Sql): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of sql.exec("SELECT k, v FROM meta").toArray()) {
    out[String(row.k)] = String(row.v);
  }
  return out;
}

// -- transcript ------------------------------------------------------------

export function transcriptAppend(sql: Sql, row: TranscriptRow): void {
  sql.exec(
    "INSERT INTO transcript (step, role, content, tool, call_id, model, tokens_in, tokens_out, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.step,
    row.role,
    row.content,
    row.tool,
    row.call_id,
    row.model,
    row.tokens_in,
    row.tokens_out,
    row.started_at,
    row.ended_at,
  );
}

export function transcriptRows(sql: Sql): Record<string, unknown>[] {
  return sql.exec("SELECT * FROM transcript ORDER BY step").toArray();
}

// -- journal (AG1) ---------------------------------------------------------

export function journalPut(sql: Sql, row: JournalRow): void {
  sql.exec(
    "INSERT OR REPLACE INTO journal (id, kind, call_id, request, tries, started_at, deadline_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
    row.kind,
    row.call_id,
    JSON.stringify(row.request),
    row.tries,
    row.started_at,
    row.deadline_at,
  );
}

export function journalGet(sql: Sql): JournalRow | null {
  const rows = sql.exec("SELECT * FROM journal WHERE id = 1").toArray();
  const r = rows[0];
  if (r === undefined) return null;
  return {
    kind: String(r.kind) as JournalRow["kind"],
    call_id: String(r.call_id),
    request: JSON.parse(String(r.request)),
    tries: Number(r.tries),
    started_at: Number(r.started_at),
    deadline_at: Number(r.deadline_at),
  };
}

export function journalRetry(sql: Sql, deadline_at: number): void {
  sql.exec("UPDATE journal SET tries = tries + 1, deadline_at = ? WHERE id = 1", deadline_at);
}

export function journalDelete(sql: Sql): void {
  sql.exec("DELETE FROM journal WHERE id = 1");
}

// -- ops and premises mirrors (MIR1) ----------------------------------------

export function opPut(sql: Sql, op_seq: number, body: unknown): void {
  sql.exec("INSERT OR REPLACE INTO ops (op_seq, body) VALUES (?, ?)", op_seq, JSON.stringify(body));
}

export function opList(sql: Sql): { op_seq: number; body: unknown }[] {
  return sql
    .exec("SELECT * FROM ops ORDER BY op_seq")
    .toArray()
    .map((r) => ({ op_seq: Number(r.op_seq), body: JSON.parse(String(r.body)) }));
}

export type PremiseMirror = {
  kind: string;
  key: string;
  hash: string;
  seq: number;
  read: boolean;
  edit: boolean;
  derived: boolean;
};

export function premisePut(sql: Sql, p: PremiseMirror): void {
  sql.exec(
    "INSERT OR REPLACE INTO premises (kind, key, hash, seq, read, edit, derived) VALUES (?, ?, ?, ?, ?, ?, ?)",
    p.kind,
    p.key,
    p.hash,
    p.seq,
    p.read ? 1 : 0,
    p.edit ? 1 : 0,
    p.derived ? 1 : 0,
  );
}

export function premiseList(sql: Sql): PremiseMirror[] {
  return sql
    .exec("SELECT * FROM premises ORDER BY kind, key")
    .toArray()
    .map((r) => ({
      kind: String(r.kind),
      key: String(r.key),
      hash: String(r.hash),
      seq: Number(r.seq),
      read: Number(r.read) === 1,
      edit: Number(r.edit) === 1,
      derived: Number(r.derived) === 1,
    }));
}

// -- inbox ------------------------------------------------------------------

// De-duplication by hn (HU4): a repeated push or a heads-up carried again in
// a response changes nothing. Returns true when the row was new.
export function inboxPut(sql: Sql, hn: number, body: unknown, received_at: number): boolean {
  const seen = sql.exec("SELECT 1 AS x FROM inbox WHERE hn = ?", hn).toArray().length === 1;
  if (seen) return false;
  sql.exec("INSERT INTO inbox (hn, body, received_at) VALUES (?, ?, ?)", hn, JSON.stringify(body), received_at);
  return true;
}

export function inboxRows(sql: Sql): InboxRow[] {
  return sql
    .exec("SELECT * FROM inbox ORDER BY hn")
    .toArray()
    .map((r) => ({
      hn: Number(r.hn),
      body: String(r.body),
      received_at: Number(r.received_at),
      shown_step: r.shown_step === null ? null : Number(r.shown_step),
    }));
}

export function inboxHns(sql: Sql): number[] {
  return sql
    .exec("SELECT hn FROM inbox ORDER BY hn")
    .toArray()
    .map((r) => Number(r.hn));
}

export function inboxBodies<T>(sql: Sql, hns: readonly number[]): T[] {
  const out: T[] = [];
  for (const hn of hns) {
    const rows = sql.exec("SELECT body FROM inbox WHERE hn = ?", hn).toArray();
    if (rows.length === 1) out.push(JSON.parse(String(rows[0]?.body)) as T);
  }
  return out;
}

export function inboxMarkShown(sql: Sql, hns: readonly number[], step: number): void {
  for (const hn of hns) sql.exec("UPDATE inbox SET shown_step = ? WHERE hn = ?", step, hn);
}

export function inboxDeleteBelow(sql: Sql, hn: number): void {
  sql.exec("DELETE FROM inbox WHERE hn <= ?", hn);
}

export function inboxDeleteHns(sql: Sql, hns: readonly number[]): void {
  for (const hn of hns) sql.exec("DELETE FROM inbox WHERE hn = ?", hn);
}

// -- timers (AL1, AL2) --------------------------------------------------------

export function timerPut(sql: Sql, kind: string, key: string, due_at: number): void {
  sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES (?, ?, ?)", kind, key, due_at);
}

export function timerDelete(sql: Sql, kind: string, key: string): void {
  sql.exec("DELETE FROM timers WHERE kind = ? AND key = ?", kind, key);
}

export function timerList(sql: Sql): TimerRow[] {
  return sql
    .exec("SELECT * FROM timers ORDER BY due_at")
    .toArray()
    .map((r) => ({ kind: String(r.kind), key: String(r.key), due_at: Number(r.due_at) }));
}

export function timerDue(sql: Sql, now: number): TimerRow[] {
  return timerList(sql).filter((t) => t.due_at <= now);
}

export function timerMin(sql: Sql): number | null {
  const rows = sql.exec("SELECT MIN(due_at) AS d FROM timers").toArray();
  return rows.length === 0 || rows[0]?.d === null || rows[0]?.d === undefined ? null : Number(rows[0]?.d);
}
