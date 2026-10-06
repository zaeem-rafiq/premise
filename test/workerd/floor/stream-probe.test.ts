// FR30 (03-floor section 7, and the Event stream row of 4.5): the page learns whether the pool in
// its address exists with a plain GET on the stream route before it opens the socket. An unknown
// pool answers 404; a pool with events answers 200, so the probe of every page load is not a
// failed request in the browser's console. Through the real Worker route, in local workerd.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendBody, poolState } from "./harness.ts";
import { startTrunkWorker, type TrunkWorker } from "../trunk/harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef"; // the made-up key of test/workerd/reads/helpers.ts

describe("FR30: the stream route's plain GET", () => {
  let worker: TrunkWorker;
  beforeAll(async () => {
    worker = await startTrunkWorker({ ownerKey: KEY });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("an unknown pool answers 404 not_found, so the page shows pool.missing", async () => {
    const response = await worker.fetch("/api/pools/probe-no-such-pool/stream");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("a pool with events answers 200, and its socket still opens", async () => {
    const seeded = await worker.floor("probe-real").fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: appendBody("trunk", 1, [{ source_n: 1, event: { ...poolState(1_000), pool: "probe-real" } }]),
    });
    expect(seeded.status).toBe(200);
    const probe = await worker.fetch("/api/pools/probe-real/stream");
    expect(probe.status).toBe(200);
    const upgrade = await worker.fetch("/api/pools/probe-real/stream", { headers: { upgrade: "websocket" } });
    expect(upgrade.status).toBe(101);
  });
});
