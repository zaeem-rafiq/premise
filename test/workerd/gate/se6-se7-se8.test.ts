// SE6, SE6a, SE7 and SE8 in local workerd: a reservation is granted and settled with real
// usage; an unsettled one is charged in full when its `expires_at` passes, driven through the
// alarm path instead of a sleep; an over-cap reservation is refused `spend_cap` with `refusing`
// on the pools' streams; and a call over a model's bucket waits (`retry_after_ms`) instead of
// being refused, as `may-start` reports the same counts `pool.state` carries.
//
// Money math, worked by hand from 01-core SE6/MG6 and the price table of model-plan.ts (BP1):
//   workhorse @cf/openai/gpt-oss-120b is $0.35/$0.75 per million tokens, so
//   bound(request_bytes, max_tokens) = (request_bytes * 0.35 + max_tokens * 0.75) / 1e6:
//     bound(10_000, 1_000)  = (3500 + 750)    / 1e6 = 0.00425   — the full charge on expiry
//     usage (2_000, 500)    = (700  + 375)    / 1e6 = 0.001075  — the real charge on settle
//   cap 0.01 refuses bound(100_000, 4_096)    = (35000 + 3072) / 1e6 = 0.038072 > 0.01
//   kimi's bucket is 16 per minute: grants 1-16 take a token, grant 17 waits
//   ceil((1 - 0) * 60_000 / 16) = 3_750 ms at the instant the bucket empties (less by the few
//   ms the run takes); the agent-slot wait is SLOT_RETRY_MS = WAIT_BACKOFF_BASE_MS = 2_000 ms.
//   expires_at = now + MODEL_TIMEOUT_MS + RESERVATION_MARGIN_MS = now + 70_000.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gateCall, startGateWorker, type GateWorker } from "./harness.ts";

const WORKHORSE = "@cf/openai/gpt-oss-120b";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";

type GateDump = {
  state: {
    spent_usd: number;
    reservations: Record<string, { amount_usd: number; expires_at: number }>;
    refusing: boolean;
    killed: boolean;
    slots: Record<string, { pool: string }>;
    pools: Record<string, { source_n: number }>;
  } | null;
};

async function spent(worker: GateWorker): Promise<number> {
  const dump = (await worker.gate().state()) as unknown as GateDump;
  return dump.state?.spent_usd ?? Number.NaN;
}

describe("SE6/SE6a: a granted reservation settles with usage; an unsettled one expires in full", () => {
  let worker: GateWorker;

  beforeAll(async () => {
    worker = await startGateWorker({ spendCapUsd: "40" });
    await gateCall(worker.gate(), "register-pool", { pool: "g-six", request_id: "req-six" });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("SE6: reserve grants; settle with usage charges the real cost, idempotently", async () => {
    const reserve = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-six-1",
      pool: "g-six",
      model: WORKHORSE,
      request_bytes: 10_000,
      max_tokens: 1_000,
    });
    const granted = (await reserve.json()) as { ok: boolean; reservation_id?: string; expires_at?: number };
    // The first reservation of a fresh gate is `r1`, held until now + 70_000.
    expect(granted).toMatchObject({ ok: true, reservation_id: "r1" });
    expect(granted.expires_at!).toBeGreaterThan(Date.now());
    // While held, the bound sits in `reserved_usd`, not `spent_usd`.
    expect(await spent(worker)).toBe(0);

    const settle = await gateCall(worker.gate(), "settle", {
      reservation_id: "r1",
      usage: { tokens_in: 2_000, tokens_out: 500 },
    });
    const settled = (await settle.json()) as { ok: boolean; charged_usd: number; found: boolean };
    expect(settled.ok).toBe(true);
    expect(settled.found).toBe(true);
    expect(settled.charged_usd).toBeCloseTo(0.001075);
    // SE6a: the real cost charged, the rest of the bound released — spent is 0.001075 now.
    expect(await spent(worker)).toBeCloseTo(0.001075);

    // A repeated settle is a no-op: found false, nothing charged again.
    const again = await gateCall(worker.gate(), "settle", {
      reservation_id: "r1",
      usage: { tokens_in: 2_000, tokens_out: 500 },
    });
    const repeated = (await again.json()) as { charged_usd: number; found: boolean };
    expect(repeated.found).toBe(false);
    expect(repeated.charged_usd).toBe(0);
    expect(await spent(worker)).toBeCloseTo(0.001075);
  });

  it("SE6a: the alarm's sweep charges an unsettled reservation in full at expires_at", async () => {
    const reserve = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-six-2",
      pool: "g-six",
      model: WORKHORSE,
      request_bytes: 10_000,
      max_tokens: 1_000,
    });
    const granted = (await reserve.json()) as { ok: boolean; reservation_id?: string; expires_at?: number };
    expect(granted).toMatchObject({ ok: true, reservation_id: "r2" });
    const expiresAt = granted.expires_at!;
    expect(expiresAt).toBeGreaterThan(Date.now() + 60_000);

    // Nothing is charged before the deadline: the sweep sees the reservation still alive.
    await worker.gate().fetch("/internal/alarm", { method: "POST" });
    expect(await spent(worker)).toBeCloseTo(0.001075);
    let dump = (await worker.gate().state()) as unknown as GateDump;
    expect(Object.keys(dump.state?.reservations ?? {})).toEqual(["r2"]);

    // Past `expires_at` the alarm's sweep charges the full bound (SE6a): 0.001075 + 0.00425.
    await worker.gate().fetch("/internal/alarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: expiresAt + 1 }),
    });
    dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.reservations).toEqual({});
    expect(await spent(worker)).toBeCloseTo(0.005325);
    // SE9: the spend change reaches the pool's stream — the last limits carries the new total.
    const events = (await worker.events("g-six")) as Array<Record<string, unknown>>;
    const last = [...events].reverse().find((event) => event.type === "limits") as { spend_usd: number } | undefined;
    expect(last?.spend_usd).toBeCloseTo(0.005325);
  });
});

describe("SE7: an over-cap reservation is refused spend_cap, and `refusing` reaches the stream", () => {
  let worker: GateWorker;

  beforeAll(async () => {
    worker = await startGateWorker({ spendCapUsd: "0.01" });
    await gateCall(worker.gate(), "register-pool", { pool: "g-cap", request_id: "req-cap" });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("bound 0.038072 over cap 0.01 answers spend_cap and broadcasts refusing", async () => {
    const reserve = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-cap-1",
      pool: "g-cap",
      model: WORKHORSE,
      request_bytes: 100_000,
      max_tokens: 4_096,
    });
    expect(await reserve.json()).toEqual({ ok: false, refused: "spend_cap" });
    const dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.refusing).toBe(true);
    // SE9: a `refusing` change broadcasts at once — the pool's last limits carries it.
    const events = (await worker.events("g-cap")) as Array<Record<string, unknown>>;
    const last = [...events].reverse().find((event) => event.type === "limits") as { refusing: boolean } | undefined;
    expect(last?.refusing).toBe(true);
  });
});

describe("SE8: over the bucket is a wait, not a refusal; may-start reports the slot counts", () => {
  let worker: GateWorker;

  beforeAll(async () => {
    worker = await startGateWorker({ spendCapUsd: "40" });
    await gateCall(worker.gate(), "register-pool", { pool: "g-rate", request_id: "req-rate" });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("the 17th kimi call of the minute answers retry_after_ms, never a refusal", async () => {
    // bound(100, 10) on kimi = (100 * 0.95 + 10 * 4.0) / 1e6 = 0.000135 — 16 of them spend
    // 0.00216, far under the cap; the 17th is stopped by the 16-per-minute bucket alone.
    for (let index = 0; index < 16; index += 1) {
      const reserve = await gateCall(worker.gate(), "reserve", {
        attempt_id: "a-rate-1",
        pool: "g-rate",
        model: KIMI,
        request_bytes: 100,
        max_tokens: 10,
      });
      expect(await reserve.json()).toMatchObject({ ok: true, reservation_id: `r${index + 1}` });
    }
    const over = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-rate-1",
      pool: "g-rate",
      model: KIMI,
      request_bytes: 100,
      max_tokens: 10,
    });
    const waited = (await over.json()) as { ok: boolean; refused?: string; retry_after_ms?: number };
    expect(waited.ok).toBe(false);
    expect(waited.refused).toBeUndefined();
    expect(waited.retry_after_ms).toBeGreaterThan(0);
    expect(waited.retry_after_ms).toBeLessThanOrEqual(3_750);
    // The wait was not a refusal: `refusing` stays false, nothing was reserved.
    const dump = (await worker.gate().state()) as unknown as GateDump;
    expect(dump.state?.refusing).toBe(false);
    expect(Object.keys(dump.state?.reservations ?? {})).toHaveLength(16);
  });

  it("may-start answers the counts pool.state shows; filling the slots makes it wait", async () => {
    // a-rate-1 holds the one slot its first kimi grant took: 1 of MAX_REAL_AGENTS = 6.
    const may = await gateCall(worker.gate(), "may-start", { attempt_id: "a-rate-1" });
    expect(await may.json()).toEqual({ ok: true, real_agents: 1, max_real_agents: 6 });
    // Five more attempts take the remaining slots on the workhorse (bound 0.0000425 each:
    // (100 * 0.35 + 10 * 0.75) / 1e6 — well under the cap).
    for (let index = 2; index <= 6; index += 1) {
      const reserve = await gateCall(worker.gate(), "reserve", {
        attempt_id: `a-rate-${index}`,
        pool: "g-rate",
        model: WORKHORSE,
        request_bytes: 100,
        max_tokens: 10,
      });
      expect(await reserve.json()).toMatchObject({ ok: true });
    }
    const mayNew = await gateCall(worker.gate(), "may-start", {});
    const blocked = (await mayNew.json()) as {
      ok: boolean;
      retry_after_ms?: number;
      real_agents: number;
      max_real_agents: number;
    };
    expect(blocked).toEqual({ ok: false, retry_after_ms: 2_000, real_agents: 6, max_real_agents: 6 });
    // The asker that already holds a slot still may.
    const mayHeld = await gateCall(worker.gate(), "may-start", { attempt_id: "a-rate-1" });
    expect(await mayHeld.json()).toEqual({ ok: true, real_agents: 6, max_real_agents: 6 });
    // MG5: release frees one slot, idempotently.
    expect(await (await gateCall(worker.gate(), "release", { attempt_id: "a-rate-2" })).json()).toEqual({
      ok: true,
      released: true,
    });
    expect(await (await gateCall(worker.gate(), "release", { attempt_id: "a-rate-2" })).json()).toEqual({
      ok: true,
      released: false,
    });
    const mayAfter = await gateCall(worker.gate(), "may-start", {});
    expect(await mayAfter.json()).toEqual({ ok: true, real_agents: 5, max_real_agents: 6 });
  });
});
