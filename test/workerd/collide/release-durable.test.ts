// SWR3's release finds its held agents from durable state, in local workerd. The defect: the
// Swarm route kept the launched attempts of each pattern in the Worker isolate's memory, so a
// release that reached another isolate (or came after the isolate was recycled) released
// nothing and the held agent never submitted. Seen live on the test deployment: a hero-c held
// for 110 s, then `release: ["hero-c"]` answered `released: []`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, launch, waitFor } from "./helpers.ts";

describe("SWR3: a release after the Worker restarted still reaches the held agent", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: ["rel1"], swarm: true });
    await createPool(worker, "rel1");
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("the held add-plain is released after a restart and lands", async () => {
    const [attempt] = await launch(worker, "rel1", ["add-plain"], { hold: ["add-plain"] });
    expect(attempt).toBeDefined();
    // SW8: every call up to the submit — its `write` is recorded — and no submit yet.
    await waitFor(
      async () =>
        (await eventsOf(worker, "rel1", "op.recorded")).some((e) => e.attempt_id === attempt) &&
        (await eventsOf(worker, "rel1", "attempt.state")).every(
          (e) => !(e.attempt_id === attempt && e.to === "submitted"),
        ),
      60_000,
    );
    // A new isolate: whatever the route kept in memory is gone; the Durable Objects' storage is not.
    await worker.restart();
    const res = await worker.fetch(
      "/api/swarm",
      bearer({ pool: "rel1", running: true, release: ["add-plain"], request_id: "r-release-rel1-after-restart" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { released: string[] }).released).toEqual([attempt]);
    await waitFor(async () => (await eventsOf(worker, "rel1", "landing.landed")).length >= 1, 60_000);
  }, 180_000);
});
