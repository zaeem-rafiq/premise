// test/workerd/trunk/trunk-do.test.ts — the Trunk Durable Object shell in local workerd.
//
// Proved here:
//   SY2   a tool call commits its transaction before any request leaves the object — the fake
//         remote's own request log records that the marker the call wrote inside its transaction
//         was already committed when the request arrived
//   AL1   the alarm handler runs and re-arms (the `events` timer of a failed delivery is covered by
//         the unit-level reschedule; a quiet alarm answers ok and leaves `timers` empty)
//   —     an unregistered engine entry answers not_built, the fail-closed code of the scaffold

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRemote, startTrunkWorker, waitFor, type TrunkWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";

describe("the Trunk Durable Object in workerd", () => {
  let worker: TrunkWorker;
  let remote: FakeRemote;

  beforeAll(async () => {
    worker = await startTrunkWorker({ ownerKey: KEY });
    remote = new FakeRemote(async (request) => {
      // The proof of SY2: while the tool call's effect is in flight, the marker its transaction
      // wrote is read back through a second, concurrent request. Were the transaction still open,
      // the marker would not be here.
      const state = (await worker.trunk("t1").state()) as { meta: Record<string, string> };
      committed.push({
        marker: String(request.body.marker ?? ""),
        committed: state.meta[`probe:${request.body.marker}`] !== undefined,
      });
      return { json: { ok: true } };
    });
    await remote.listen();
  }, 60_000);
  afterAll(async () => {
    await worker.dispose();
    await remote.close();
  });

  const committed: { marker: string; committed: boolean }[] = [];

  it("SY2: a tool call commits its transaction before any request leaves the object", async () => {
    // `_probe` is the slice's fake engine entry: it writes `probe:<marker>` inside the tool call's
    // transaction and leaves a `_remote_probe` effect, which POSTs to the fake remote.
    const res = await worker.trunk("t1").fetch("/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attempt_id: "a1",
        call_id: "a1:1",
        ack: 0,
        tool: "_probe",
        args: { url: `${remote.url}/hook`, marker: "m1" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ call_id: "a1:1", ok: true, result: { marked: "m1" } });

    // The remote's request log: one request, and the marker was committed when it arrived.
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0]?.path).toBe("/hook");
    expect(committed).toEqual([{ marker: "m1", committed: true }]);

    // The marker is durable in the object's own state too.
    const state = (await worker.trunk("t1").state()) as { meta: Record<string, string> };
    expect(state.meta["probe:m1"]).toBeDefined();
  });

  it("GET requests take their input on ?q= (the fetchDurableObject convention)", async () => {
    const res = await worker.trunk("t1").fetch(
      `/tool?q=${encodeURIComponent(
        JSON.stringify({
          attempt_id: "a1",
          call_id: "a1:2",
          ack: 0,
          tool: "_probe",
          args: { url: `${remote.url}/q`, marker: "m2" },
        }),
      )}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { marked: "m2" } });
  });

  it("an unregistered engine entry answers not_built; a registered one on a missing pool answers pool_not_found", async () => {
    // Slice 0 asserted 503 everywhere — the engine was not wired. Slice 1 wires it, so a real
    // entry on a pool that was never created answers 404 `pool_not_found`, and only genuinely
    // unregistered names still fail closed with 503 `not_built`.
    const tool = await worker.trunk("t1").fetch("/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "a1", call_id: "a1:3", ack: 0, tool: "write", args: {} }),
    });
    expect(tool.status).toBe(404);
    expect(await tool.json()).toEqual({ error: { code: "pool_not_found" } });

    for (const path of ["/sync", "/stop"]) {
      const res = await worker
        .trunk("t1")
        .fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "pool_not_found" } });
    }
    for (const path of ["/register", "/api/pools/t1/intents", "/api/pools/t1/undo"]) {
      const res = await worker
        .trunk("t1")
        .fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "not_built" } });
    }
    const undoPlan = await worker.trunk("t1").fetch("/api/pools/t1/undo-plan");
    expect(undoPlan.status).toBe(503);
  });

  it("the creation endpoint stores the record and reports already/exists on repeats", async () => {
    const res = await worker.trunk("t9").fetch("/internal/create-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pool: "t9",
        seed: "tidepool",
        summary_only: true,
        request_id: "r9",
        remote: "https://x/repo",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "t9" });
    // The events were flushed: the Floor of t9 holds pool.state + pool.files (and, with the fake
    // remote unreachable, the push.retry rows of LP5a — the count is at least the first two).
    const floor = (await worker.floor("t9").state()) as { n: number };
    expect(floor.n).toBeGreaterThanOrEqual(2);
    const bad = await worker.trunk("t9").fetch("/internal/create-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: "t9" }),
    });
    expect(bad.status).toBe(400);
  });

  it("AL1: the alarm handler runs, and an empty timers table re-arms to nothing", async () => {
    const res = await worker.trunk("t1").fetch("/internal/alarm");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const state = (await worker.trunk("t1").state()) as { timers: unknown[] };
    expect(state.timers).toHaveLength(0);
  });
});
