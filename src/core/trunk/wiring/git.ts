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
  // IR3's ingestion: the `rebuild` timer's runs of the import job commit through this entry —
  // same resumable shape as `rebuild_step` (RB3/RB4), on a pool born `rebuilding` (IR3).
  table.entries.set("import_step", (input, ctx) => trunk(ctx).importStep(input as Parameters<Trunk["importStep"]>[0]));
  table.entries.set("register", (input, ctx) => trunk(ctx).register(input as RegisterRequest));
  // The plain-merge pool (11.7): `plain` on its timer builds the next commit spec, `plain_done`
  // applies the push's answer.
  table.entries.set("plain", (input, ctx) => trunk(ctx).plain(input as { parent_override?: string }));
  table.entries.set("plain_done", (input, ctx) => trunk(ctx).plainDone(input as { commit: string; remote: string }));
  // The green line (11.5): `green` on its timer names the next commit to verify, `green_done`
  // applies the verification's answer after the worker moved `refs/heads/green` (GR2a).
  table.entries.set("green", (_input, ctx) => trunk(ctx).green());
  table.entries.set("green_done", (input, ctx) => trunk(ctx).greenDone(input as Parameters<Trunk["greenDone"]>[0]));
}
