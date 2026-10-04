// The trunk lane's wiring module for the effects seam (04-build-plan 3.2). The lane registers its
// effect handlers here; it edits this file, never `../effects.ts`.
//
// `events` is the lane's own effect kind (EV2): every entry that emits stream events leaves it, and
// its handler is the outbox flush to the pool's Floor. `_remote_probe` is the fake remote of the SY2
// acceptance: the `_probe` entry commits a marker and leaves this effect, whose POST to the test's
// fake remote proves (by the remote's own log) that the request left after the commit.

import { deliverEvents } from "../after-commit.ts";
import type { EffectTable } from "../effects.ts";

export function wire(table: EffectTable): void {
  table.handlers.set("events", ({ env, ctx }) => deliverEvents(env, ctx));

  table.handlers.set("_remote_probe", async ({ payload }) => {
    const probe = payload as { url?: unknown; marker?: unknown };
    if (typeof probe?.url !== "string") return;
    await fetch(probe.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote_probe: true, marker: typeof probe.marker === "string" ? probe.marker : null }),
    });
  });
}
