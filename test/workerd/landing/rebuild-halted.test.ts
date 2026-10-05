// RB1's exception for a halted pool, in local workerd. The defect, seen live on the test
// deployment: a pool paused with `push_rejected` keeps its refused batch `pending` for ever,
// because a halted pool does not push (LP8); the owner's rebuild waited for that batch to
// reconcile and re-armed its timer every 250 ms, without end. The rebuild now closes the halted
// row and starts at once; and any wait for reconciliation backs off.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../trunk/harness.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const POOL = "it-halted";

function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

const FAR = () => Date.now() + 3_600_000;

describe("RB1 and LP8: the owner's rebuild of a pool paused for a refused push", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL], refuseRepos: [POOL] });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("does not wait for the halted batch: the job runs instead of re-arming itself", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, seed: "tidepool-swarm", summary_only: false, request_id: "r-halted" }),
    );
    expect(create.status).toBe(200);
    // LP5b: the refused seed batch retries, then the pool pauses with push_rejected.
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const meta = (await worker.trunk(POOL).state()).meta as Record<string, string>;
      if (meta.pool_state === "paused") break;
      await worker.runAlarm(POOL, FAR());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const paused = (await worker.trunk(POOL).state()) as { meta: Record<string, string> };
    expect(paused.meta.pause_reason).toBe("push_rejected");

    const rebuild = await worker.fetch(`/api/pools/${POOL}/rebuild`, bearer({ request_id: "r-rebuild-halted" }));
    expect(rebuild.status).toBe(200);
    // Three alarm runs. The remote was never written (every push was refused), so the job finds
    // no `main` and releases its arm (the pool keeps its pause for the owner). Before the fix it
    // never got that far: each run re-armed the `rebuild` timer 250 ms ahead.
    for (let k = 0; k < 3; k += 1) await worker.runAlarm(POOL, FAR());
    // A run may still be reading the remote when the test's own alarm runs return; the job is
    // done when its cursor and its timer are both gone (before the fix the timer never went).
    await waitFor(async () => {
      const state = (await worker.trunk(POOL).state()) as {
        meta: Record<string, string>;
        timers: Array<{ kind: string }>;
      };
      return state.meta.rebuild_cursor === undefined && state.timers.every((t) => t.kind !== "rebuild");
    }, 15_000);
    const after = (await worker.trunk(POOL).state()) as { meta: Record<string, string> };
    expect(after.meta.pool_state).toBe("paused");
  }, 90_000);
});
