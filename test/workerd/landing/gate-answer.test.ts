// SE6 with EV2a: the model gate answers a reserve as soon as the call is committed, not after it
// has delivered the owed `limits` events to every registered pool's Floor. Found on `test`
// 2026-10-11: with ~240 registered pools every agent turn waited ~50 s on serial deliveries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLandingWorker, type LandingWorker } from "./harness.ts";

const POOL = "g-hang";
let worker: LandingWorker | undefined;

function gate(path: string, body: unknown): Promise<Response> {
  return worker!.object("GATE", "premise").fetch(`/internal/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the gate's answer does not wait for Floor deliveries", () => {
  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: "k", repos: [POOL], floorFaults: true, spendCapUsd: "30" });
  }, 60_000);
  afterAll(async () => worker?.dispose());

  it("SE6/EV2a: a reserve answers within 2 s while the pool's Floor does not answer the gate", async () => {
    expect((await gate("register-pool", { pool: POOL })).ok).toBe(true);
    const fault = await worker!.object("FLOOR", POOL).fetch("/__test/floor-fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "hang-gate" }),
    });
    expect(fault.ok).toBe(true);

    const started = Date.now();
    const reserve = await gate("reserve", {
      attempt_id: "a-hang-1",
      pool: POOL,
      model: "@cf/openai/gpt-oss-120b",
      request_bytes: 10_000,
      max_tokens: 1_000,
    });
    const elapsed = Date.now() - started;
    expect(await reserve.json()).toMatchObject({ ok: true });
    expect(elapsed).toBeLessThan(2_000);

    await worker!.object("FLOOR", POOL).fetch("/__test/floor-fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "pass" }),
    });
  }, 30_000);
});
