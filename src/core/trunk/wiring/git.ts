// The git lane's wiring module for the engine seam (04-build-plan 3.2). The lane registers its
// engine entries here; it edits this file, never `../engine.ts`.
//
// The push lifecycle lives in the engine's `push_ok`, `push_result` and `restart` entries (wired
// by the engine lane) and in the Durable Object's after-commit push work (`src/worker/trunk/`).
// Registered here: the rebuild-from-Artifacts entries (3.6 — `rebuild` arms the job, `rebuild_begin`
// and `rebuild_step` commit the job's runs, `rebuild_lost` is step 8's deadline) and `register`,
// the Agent's post-rebuild re-registration call (4.12).

import type { EngineTable } from "../engine.ts";
import type { Trunk } from "../registry.ts";
import type { RegisterRequest } from "../../../protocol/tools.ts";
import type { ApplyPayload } from "../../rebuild/plan.ts";

export function wire(table: EngineTable): void {
  const trunk = (ctx: unknown): Trunk => ctx as Trunk;
  table.entries.set("rebuild", (input, ctx) =>
    trunk(ctx).rebuild((input as { request_id?: unknown }).request_id as string),
  );
  table.entries.set("rebuild_begin", (input, ctx) =>
    trunk(ctx).rebuildBegin(input as Parameters<Trunk["rebuildBegin"]>[0]),
  );
  table.entries.set("rebuild_step", (input, ctx) => trunk(ctx).rebuildStep(input as ApplyPayload));
  table.entries.set("rebuild_lost", (_input, ctx) => trunk(ctx).rebuildLost());
  table.entries.set("register", (input, ctx) => trunk(ctx).register(input as RegisterRequest));
}
