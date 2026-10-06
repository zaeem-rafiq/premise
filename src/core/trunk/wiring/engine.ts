// The engine lane's wiring module for the engine seam (04-build-plan 3.2). The lane registers its
// engine entries here; it edits this file, never `../engine.ts`.
//
// test/arch/seams.test.ts ("Slice 0") asserts `engineTable()` is empty until the lead lifts that
// gate, so `wire` stays a no-op for now. The entries are defined in `wireEngineEntries` below —
// activating the registration is the one-line body `wireEngineEntries(table)`.
//
// Each entry refines `EntryHandler`: `ctx` is the caller's `Trunk` (see `registry.ts`), `input`
// the entry's arguments. The seam types both as `unknown` so a lane owns its signatures.

import type { EngineTable } from "../engine.ts";
import type { Trunk } from "../registry.ts";
import type { ToolRequest } from "../../../protocol/tools.ts";
import type { TrunkOpenAttemptRequest } from "../../../protocol/internal.ts";

export function wire(table: EngineTable): void {
  wireEngineEntries(table);
}

/** The engine lane's entries, ready to register into `table` (9.1, 9.4, 9.8, 10.3, 12.4). */
export function wireEngineEntries(table: EngineTable): void {
  const trunk = (ctx: unknown): Trunk => ctx as Trunk;
  // The seven tools of 01-core.md 4.3, reached through one entry (TA1-TA5 in the tool envelope).
  // The launcher's `open_attempt` (SWR2): creates the intent + attempt, emitting `intent.created`,
  // `pool.state` (EM1a on the first synthetic) and `attempt.opened`. Idempotent by attempt id (9.8).
  table.entries.set("open_attempt", (input, ctx) => {
    const req = input as TrunkOpenAttemptRequest;
    const t = trunk(ctx);
    const already = t.pool.attempts.has(req.attempt_id);
    // IR3/RB3: an intent for a pool still rebuilding — an imported pool's ingestion included —
    // is refused `pool_not_ready`. Idempotency first: a retry of an attempt the pool already
    // holds answers it, whatever the state.
    if (!already && (t.pool.meta.get("pool_state") ?? "ready") !== "ready") {
      return { ok: false, error: "pool_not_ready" };
    }
    const a = t.openAttempt(req.attempt_id, req);
    return { ok: true, attempt_id: a.id, change_id: a.change_id, intent_id: a.intent_id, already };
  });
  table.entries.set("tool", (input, ctx) => trunk(ctx).tool(input as ToolRequest));
  // The non-tool calls of 9.1: sync (T12), stop (T20), tick (9.4), the push steps (9.8),
  // triage (7.3), restart (TR6) and the owner actions (10.3).
  table.entries.set("sync", (input, ctx) => trunk(ctx).sync(input as { attempt_id: string; ack: number }));
  table.entries.set("stop", (input, ctx) => trunk(ctx).stop(input as { attempt_id: string; reason: string }));
  table.entries.set("tick", (_input, ctx) => {
    trunk(ctx).tick();
  });
  table.entries.set("push_ok", (_input, ctx) => {
    trunk(ctx).pushOk();
  });
  table.entries.set("push_result", (input, ctx) =>
    trunk(ctx).pushResult(
      (input as { remote_main: "old" | "new" | "other" }).remote_main,
      (input as { remote_notes?: "old" | "new" | "other" }).remote_notes,
    ),
  );
  table.entries.set("triage", (input, ctx) => {
    trunk(ctx).triage(input as Parameters<Trunk["triage"]>[0]);
  });
  table.entries.set("restart", (input, ctx) => trunk(ctx).restart(input as Parameters<Trunk["restart"]>[0]));
  // RW1's lapse (3.3): the row's `due_at` identifies the grant it was armed for — the entry
  // clears only a mark still holding that grant, then runs the tick that lands what waited.
  table.entries.set("right_of_way", (input, ctx) => {
    const t = (input as { timer?: { key?: unknown; due_at?: unknown } }).timer;
    trunk(ctx).expireRightOfWay({
      attempt_id: typeof t?.key === "string" ? t.key : "",
      due_at: typeof t?.due_at === "number" ? t.due_at : 0,
    });
  });
  table.entries.set("owner", (input, ctx) => trunk(ctx).owner(input as Parameters<Trunk["owner"]>[0]));
  table.entries.set("undo_plan", (input, ctx) => trunk(ctx).undoPlan((input as { seq: number }).seq));
  table.entries.set("undo", (input, ctx) => trunk(ctx).undo(input as Parameters<Trunk["undo"]>[0]));
  // The effects the worker runs after a transaction (12.4): the EV2 event delivery and the LP6
  // push outbox — the kinds `src/worker/trunk/effects.ts` registers handlers under.
  table.effects.add("events");
  table.effects.add("push");
}
