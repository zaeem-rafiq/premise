// Plan 2.5 item 9 — EV2a, EM6 and SE9, run in local workerd against the built bundle:
//
//   - each of two pools registered with the gate receives `limits` events on its own Floor
//     stream, with `src` "gate" and numbered by that pool's own `source_n`;
//   - a pool's first `limits` arrives at its registration (SE9);
//   - a `source_n` the Floor already stores is confirmed as a duplicate and never lands twice
//     (EV2a's at-least-once delivery, EM6).
//
// Expected values, worked by hand from 01-core 12.1/EV2a and the pure gate's rules (BP1):
// the registration's first `limits` is source_n 1 of that pool's counter; nothing has been
// spent or reserved yet, `killed` and `refusing` are false, `cap_usd` is the deployment's
// SPEND_CAP_USD of 40; a state change the `limits` throttle broadcasts at once gives every
// registered pool its next source_n (here, each pool's 2).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gateCall, startGateWorker, type GateWorker } from "./harness.ts";

const WORKHORSE = "@cf/openai/gpt-oss-120b";
const RACE_MODELS = ["@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.3-flash"];

type LimitsEvent = {
  n: number;
  src: string;
  type: string;
  pool: string;
  spend_usd: number;
  reserved_usd: number;
  cap_usd: number;
  killed: boolean;
  refusing: boolean;
  models: Array<{ model: string; per_minute: number; used_last_minute: number }>;
};

type GateDump = {
  state: { pools: Record<string, { source_n: number }>; epoch: number } | null;
  outbox: Array<{ pool: string; n: number; epoch: number }>;
  delivery: Array<{ pool: string; tries: number; retry_at: number }>;
};

async function limitsOf(worker: GateWorker, pool: string): Promise<LimitsEvent[]> {
  const events = (await worker.events(pool)) as unknown as LimitsEvent[];
  return events.filter((event) => event.type === "limits");
}

describe("SE9/EV2a/EM6: limits to every registered pool, each with its own source_n", () => {
  let worker: GateWorker;

  beforeAll(async () => {
    worker = await startGateWorker({ spendCapUsd: "40" });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("registration delivers a first limits, src gate, that pool's own source_n 1", async () => {
    for (const pool of ["g-nine-a", "g-nine-b"]) {
      const response = await gateCall(worker.gate(), "register-pool", { pool, request_id: `req-${pool}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, pool });
    }
    for (const pool of ["g-nine-a", "g-nine-b"]) {
      const limits = await limitsOf(worker, pool);
      // The first limits arrived at the registration itself — nothing else ran yet (SE9).
      expect(limits).toHaveLength(1);
      const event = limits[0]!;
      expect(event.src).toBe("gate");
      expect(event.pool).toBe(pool);
      expect(event).toMatchObject({
        spend_usd: 0,
        reserved_usd: 0,
        cap_usd: 40,
        killed: false,
        refusing: false,
      });
      // The plan's three models ride the event with their per-minute rates (S5's table).
      expect(event.models.map((m) => [m.model, m.per_minute]).sort()).toEqual(
        [
          [WORKHORSE, 240],
          [RACE_MODELS[0]!, 16],
          [RACE_MODELS[1]!, 16],
        ].sort(),
      );
      // EV1: the pool's own stream numbers it 1 — its first event.
      expect(event.n).toBe(1);
    }
    // EV2a: one `source_n` sequence per pool — each stands at 1 after its first limits.
    const dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.pools["g-nine-a"]).toEqual({ source_n: 1 });
    expect(dump.state?.pools["g-nine-b"]).toEqual({ source_n: 1 });
    // And the Floor confirmed both deliveries: nothing is left in the outbox.
    expect(dump.outbox).toEqual([]);
  });

  it("a throttled-eligible broadcast still numbers each pool with its own counter", async () => {
    // The first reserve after the registrations spends nothing yet but flips `limits_at` from
    // null, so the spend change broadcasts at once: each pool's source_n 2.
    const response = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-nine-1",
      pool: "g-nine-a",
      model: WORKHORSE,
      request_bytes: 1_000,
      max_tokens: 100,
    });
    expect(await response.json()).toMatchObject({ ok: true, reservation_id: "r1" });
    for (const pool of ["g-nine-a", "g-nine-b"]) {
      const limits = await limitsOf(worker, pool);
      expect(limits).toHaveLength(2);
      // The stream holds them in the source's order under contiguous Floor numbers (EV1).
      expect(limits.map((event) => event.n)).toEqual([1, 2]);
      // The second limits carries the reservation: bound(1000, 100) on the workhorse
      // = (1000 * 0.35 + 100 * 0.75) / 1e6 = 0.000425.
      expect(limits[1]!.reserved_usd).toBeCloseTo(0.000425);
      expect(limits[1]!.models.find((m) => m.model === WORKHORSE)?.used_last_minute).toBe(1);
    }
    const dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.pools["g-nine-a"]).toEqual({ source_n: 2 });
    expect(dump.state?.pools["g-nine-b"]).toEqual({ source_n: 2 });
    expect(dump.outbox).toEqual([]);
  });

  it("a source_n the Floor already has is confirmed and never lands twice", async () => {
    // Stand in for a Floor that stored rows 3 and 4 of source "gate" — e.g. a crash between its
    // append and the gate's confirm (EM6: delivery is at least once, the stream exactly once).
    const fake = {
      ts: 0,
      pool: "g-nine-a",
      src: "gate",
      type: "limits",
      spend_usd: 0,
      reserved_usd: 0,
      cap_usd: 40,
      killed: false,
      refusing: true,
      models: [],
    };
    const injected = await worker.floor("g-nine-a").fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "gate", epoch: 1, events: [3, 4].map((source_n) => ({ source_n, event: fake })) }),
    });
    expect(injected.status).toBe(200);
    // The gate's next two emissions for the pool answer `duplicate` and are dropped by the
    // Floor; its numbering then catches up and the third real one lands exactly once.
    for (const killed of [true, false, true]) {
      const response = await gateCall(worker.gate(), "kill", { killed });
      expect(await response.json()).toEqual({ ok: true, killed });
    }
    const limits = await limitsOf(worker, "g-nine-a");
    // 2 real + 2 injected + 1 real (#4, source_n 5 in the gate's counter? no — the gate's own
    // numbering is continuous: real emissions were 1,2,3,4; the injected pair claimed 3,4 on the
    // Floor, so real 3 and 4 were duplicates and real 5 = killed:true lands as n 5).
    expect(limits).toHaveLength(5);
    expect(limits.map((event) => event.n)).toEqual([1, 2, 3, 4, 5]);
    expect(limits[4]).toMatchObject({ src: "gate", killed: true });
    // No event landed twice: every `n` appears once and the duplicate drops are visible in the
    // counter — the gate's pool counter stands at 5, the stream at 5.
    const dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.pools["g-nine-a"]).toEqual({ source_n: 5 });
    expect(dump.outbox).toEqual([]);
    // Cleaning the kill for the rest of the suite's expectations.
    const unkill = await gateCall(worker.gate(), "kill", { killed: false });
    expect(await unkill.json()).toEqual({ ok: true, killed: false });
  });
});
