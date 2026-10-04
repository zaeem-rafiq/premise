// src/worker/agent/events.ts — the Agent's own event outbox (EV2a, EV2).
//
// The Agent is a stream source under `agent:<attempt_id>`: the `attempt.step`
// of a model turn (tool null, tokens, cost) and of a tool turn (tool, target,
// ok, ms) are facts only the Agent knows, so the Agent — not Trunk — emits
// them. Rows go into `agent_events` inside the same transaction as the state
// change they describe (EV2); `#deliver` posts them to the pool's Floor in
// `source_n` order and deletes what the Floor confirmed, like Trunk's outbox.

import type { Sql } from "../../protocol/ports.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import type { FloorAppendRequest, FloorAppendResponse } from "../../protocol/internal.ts";
import type { StreamSource } from "../../protocol/stream.ts";
import { agentSourceId } from "../../protocol/stream.ts";
import { HEADS_UP_REPUSH_MS } from "../../protocol/constants.ts";
import { timerPut } from "../../core/agent/store.ts";

export type AgentEvent = PoolEvent extends infer E ? (E extends PoolEvent ? Omit<E, "n" | "t"> : never) : never;

/** The Agent's own outbox table — worker-side so `src/core` stays untouched.
 * `applySchema` creates the shared tables; this adds the lane's own. */
export function ensureEventsSchema(sql: Sql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS agent_events (
      n INTEGER PRIMARY KEY,
      event TEXT NOT NULL
    )`,
  );
}

export function appendEvent(sql: Sql, event: AgentEvent): void {
  const rows = sql.exec("SELECT COALESCE(MAX(n), 0) AS m FROM agent_events").toArray();
  const n = Number(rows[0]?.m ?? 0) + 1;
  sql.exec("INSERT INTO agent_events (n, event) VALUES (?, ?)", n, JSON.stringify(event));
}

export function pendingEvents(sql: Sql): { n: number; event: AgentEvent }[] {
  return sql
    .exec("SELECT n, event FROM agent_events ORDER BY n")
    .toArray()
    .map((r) => ({ n: Number(r.n), event: JSON.parse(String(r.event)) as AgentEvent }));
}

export function confirmEvents(sql: Sql, through: number): void {
  sql.exec("DELETE FROM agent_events WHERE n <= ?", through);
}

/**
 * Deliver pending rows to the pool's Floor. On `appended` or `duplicate` the
 * confirmed rows go; on `gap` the Floor's `expected` resynchronizes the send —
 * everything before it was already delivered, so it is confirmed and the rest
 * is sent again on the next pass. A transport failure arms the `events` timer.
 */
export async function deliverEvents(
  sql: Sql,
  floor: { post(path: string, body: unknown): Promise<Response> },
  attemptId: string,
): Promise<boolean> {
  for (;;) {
    const rows = pendingEvents(sql);
    if (rows.length === 0) return true;
    const body: FloorAppendRequest = {
      source: agentSourceId(attemptId) as StreamSource,
      epoch: 1,
      events: rows.map((r) => ({ source_n: r.n, event: r.event })),
    };
    let res: Response;
    try {
      res = await floor.post("/internal/events", body);
    } catch {
      timerPut(sql, "events", "main", Date.now() + HEADS_UP_REPUSH_MS);
      return false;
    }
    if (!res.ok) {
      timerPut(sql, "events", "main", Date.now() + HEADS_UP_REPUSH_MS);
      return false;
    }
    const answer = (await res.json().catch(() => null)) as FloorAppendResponse | null;
    if (answer === null) {
      timerPut(sql, "events", "main", Date.now() + HEADS_UP_REPUSH_MS);
      return false;
    }
    if ("appended" in answer || ("duplicate" in answer && answer.duplicate === true)) {
      const last = "last_n" in answer && typeof answer.last_n === "number" ? answer.last_n : rows[rows.length - 1]!.n;
      confirmEvents(sql, Math.min(last, rows[rows.length - 1]!.n));
      continue; // more may be pending
    }
    if ("error" in answer && answer.error.code === "gap" && typeof answer.error.expected === "number") {
      confirmEvents(sql, answer.error.expected - 1);
      continue; // resend from the expected number
    }
    timerPut(sql, "events", "main", Date.now() + HEADS_UP_REPUSH_MS);
    return false;
  }
}
