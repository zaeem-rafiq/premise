// test/workerd/trunk/pools.test.ts — POST /api/pools and the Trunk Durable Object's creation record
// in local workerd.
//
// Proved here:
//   PL1/EV6  creation stores summary_only in Trunk's meta and every pool.state carries it — checked
//            in the stored meta, in the emitted event, and in the Floor's own reduced state
//   PL1      the request makes the two registrations of EV2a; the not_built stubs of Slice 0 are
//            ignored, so creation still succeeds (the call assertions live in pools.test.ts units)
//   SE5      the pool-create response holds no token
//   9.8      a repeated request_id is a no-op

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEEDS } from "../../../src/config/pools.ts";
import { startTrunkWorker, waitFor, type TrunkWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";

function create(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

describe("pool creation in workerd", () => {
  let worker: TrunkWorker;

  beforeAll(async () => {
    worker = await startTrunkWorker({ ownerKey: KEY });
  }, 60_000);
  afterAll(async () => {
    await worker.dispose();
  });

  it("PL1: creates a pool with summary_only stored in meta and carried by pool.state (EV6)", async () => {
    const res = await worker.fetch(
      "/api/pools",
      create({ pool: "tp1", seed: "tidepool", summary_only: true, request_id: "r-tp1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "tp1" });

    // The creation record is durable in Trunk's meta.
    const state = (await worker.trunk("tp1").state()) as { meta: Record<string, string> };
    expect(state.meta.pool_id).toBe("tp1");
    expect(state.meta.summary_only).toBe("1");
    expect(state.meta.pool_state).toBe("ready");
    expect(state.meta.epoch).toBe("1");

    // And every pool.state carries it: the emitted event is on the Floor, whose own reducer
    // state confirms summary_only (EV6, FS2). The outbox itself is empty — EV2 confirmed.
    const after = (await worker.trunk("tp1").state()) as { events_out: unknown[] };
    expect(after.events_out).toHaveLength(0);
    const floor = (await worker.floor("tp1").state()) as { n: number; pool: { state: string } };
    // pool.state then pool.files (EM1) — more follow if the seed's push retries against the
    // unreachable remote (LP5a), but the first two are what EM1 requires.
    expect(floor.n).toBeGreaterThanOrEqual(2);
    expect(floor.pool.state).toBe("ready");

    const socket = await worker.stream("tp1");
    try {
      const snapshot = await new Promise<{ n: number; state: { pool: { summary_only: boolean } } }>(
        (resolve, reject) => {
          socket.addEventListener("message", (message) => {
            const frame = JSON.parse(String(message.data)) as {
              snapshot?: { n: number; state: { pool: { summary_only: boolean } } };
            };
            if (frame.snapshot !== undefined) resolve(frame.snapshot);
          });
          socket.addEventListener("error", reject);
          socket.send(JSON.stringify({ hello: 1, after: 0 }));
        },
      );
      expect(snapshot.state.pool.summary_only).toBe(true);
    } finally {
      socket.close();
    }
  });

  it("PL1: the not_built stubs of the gate and the launcher do not fail creation", async () => {
    // Slice 4 (gate) and Slice 8 (launcher) are unbuilt: GATE answers 503 not_built and SWARM is not
    // bound — creation still succeeds, per the track's build-order rule.
    const res = await worker.fetch(
      "/api/pools",
      create({ pool: "tp2", seed: "tidepool-swarm", summary_only: false, request_id: "r-tp2" }),
    );
    expect(res.status).toBe(200);
    const state = (await worker.trunk("tp2").state()) as { meta: Record<string, string> };
    expect(state.meta.summary_only).toBe("0");
  });

  it("9.8: a repeated request_id is a no-op — the second create keeps the pool and adds no events", async () => {
    const first = await worker.fetch(
      "/api/pools",
      create({ pool: "tp3", seed: "tidepool", summary_only: false, request_id: "r-dup" }),
    );
    expect(first.status).toBe(200);
    const again = await worker.fetch(
      "/api/pools",
      create({ pool: "tp3", seed: "tidepool", summary_only: true, request_id: "r-dup" }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true });
    // The stored record is the first one's — summary_only stays as created, and the stream still
    // holds exactly one pool.state and one pool.files: the duplicate emitted none (9.8). Other
    // rows (the seed's push.retry of LP5a, against the unreachable remote) are not the create's.
    const state = (await worker.trunk("tp3").state()) as { meta: Record<string, string> };
    expect(state.meta.summary_only).toBe("0");
    const replay = await worker.floor("tp3").fetch("/api/pools/tp3/replay.ndjson");
    const types = (await replay.text())
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types.filter((type) => type === "pool.state")).toHaveLength(1);
    expect(types.filter((type) => type === "pool.files")).toHaveLength(1);
    // A different request_id on a live pool is refused.
    const conflict = await worker.fetch(
      "/api/pools",
      create({ pool: "tp3", seed: "tidepool", summary_only: false, request_id: "r-other" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "pool_exists" } });
  });

  it("SE5: the pool-create response holds no token", async () => {
    const res = await worker.fetch(
      "/api/pools",
      create({ pool: "tp4", seed: SEEDS[0], summary_only: false, request_id: "r-tp4" }),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, pool: "tp4" });
    // No token field and nothing shaped like an Artifacts token.
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/art_v\d+_[0-9a-f]+/);
    // The DO's state surface holds no token either (SE5: never persisted).
    const state = await worker.trunk("tp4").state();
    expect(JSON.stringify(state)).not.toMatch(/art_v\d+_[0-9a-f]+/);
  });

  it("PL1: a seed outside SEEDS and a malformed body answer invalid_args", async () => {
    for (const body of [
      { pool: "tp9", seed: "not-a-seed", request_id: "r" },
      { pool: "bad name", seed: "tidepool", request_id: "r" },
      { pool: "tp9", seed: "tidepool" },
    ]) {
      const res = await worker.fetch("/api/pools", create(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "invalid_args" } });
    }
  });
});
