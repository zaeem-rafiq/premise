// SE6, SE6a, SE7: reserve, settle, sweep. Expected costs are worked from MG6's bound formula and
// TL4's cost formula against the prices below — never read back from the implementation (BP1).
// Prices: in $0.35, out $0.75 per million tokens (the workhorse's MG2 row).

import { describe, expect, it } from "vitest";
import type { ModelPlan } from "../../protocol/ports.ts";
import { MODEL_TIMEOUT_MS, RESERVATION_MARGIN_MS } from "../../protocol/constants.ts";
import { initialState, reservedTotal, RESERVATION_TTL_MS } from "./state.ts";
import { amountOf, reserve, settle, sweep } from "./reserve.ts";
import { registerPool } from "./limits.ts";
import type { GateEffect } from "./types.ts";

const PRICES = { "@cf/a": { in: 0.35, out: 0.75 }, "@cf/b": { in: 0.95, out: 4.0 } };

const plan = (over: Partial<ModelPlan> = {}): ModelPlan => ({
  workhorse: "@cf/a",
  race: ["@cf/a", "@cf/b"],
  per_minute: { "@cf/a": 240, "@cf/b": 16 },
  max_real_agents: 6,
  prices_usd_per_mtok: PRICES,
  ...over,
});

const REQ = { attempt_id: "att-1", pool: "p1", model: "@cf/a", request_bytes: 10_000, max_tokens: 4_096 };

function emits(effects: GateEffect[]) {
  return effects.filter((e) => e.kind === "emit");
}

describe("reserve (SE6)", () => {
  it("SE6 answers { reservation_id, expires_at } and reserves the SE6 bound", () => {
    const state = initialState(40);
    const { answer } = reserve(state, REQ, 1_000, plan(), PRICES);
    expect(answer).toEqual({ ok: true, reservation_id: "r1", expires_at: 1_000 + RESERVATION_TTL_MS });
    // MG6: 10,000 input bytes x $0.35/MTok + 4,096 tokens x $0.75/MTok
    //    = (10,000 x 0.35 + 4,096 x 0.75) / 1,000,000 = (3,500 + 3,072) / 1e6 = 0.006572.
    expect(reservedTotal(state)).toBeCloseTo(0.006572);
    expect(state.reservations["r1"]?.amount_usd).toBeCloseTo(0.006572);
  });

  it("SE6 derives reservation ids from a state counter — never random", () => {
    const state = initialState(40);
    const a = reserve(state, REQ, 0, plan(), PRICES);
    const b = reserve(state, { ...REQ, attempt_id: "att-2" }, 0, plan(), PRICES);
    if (!a.answer.ok || !b.answer.ok) throw new Error("expected granted reservations");
    expect(a.answer.reservation_id).toBe("r1");
    expect(b.answer.reservation_id).toBe("r2");
  });

  it("SE6 expires_at is MODEL_TIMEOUT_MS + RESERVATION_MARGIN_MS out (SE6a)", () => {
    expect(RESERVATION_TTL_MS).toBe(MODEL_TIMEOUT_MS + RESERVATION_MARGIN_MS); // 60,000 + 10,000
  });

  it("SE6 reserves nothing and consumes no bucket token when the spend cap refuses", () => {
    const state = initialState(0.001);
    const { answer } = reserve(state, REQ, 0, plan(), PRICES);
    expect(answer).toEqual({ ok: false, refused: "spend_cap" });
    expect(reservedTotal(state)).toBe(0);
    expect(state.buckets["@cf/a"]).toBeUndefined();
  });

  it("SE8 a full agent-slot table answers retry_after_ms, not a refusal", () => {
    const p = plan({ max_real_agents: 1 });
    const state = initialState(40);
    state.slots["att-9"] = { pool: "p1" };
    const { answer } = reserve(state, REQ, 0, p, PRICES);
    expect(answer).toEqual({ ok: false, retry_after_ms: 2_000 });
    expect(reservedTotal(state)).toBe(0);
  });

  it("MG5 the first granted reservation of an attempt takes the slot; a Clef model takes none", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    expect(state.slots["att-1"]).toEqual({ pool: "p1" });
    const clef = reserve(
      state,
      { attempt_id: "trunk", pool: "p1", model: "@cf/cloudflare/clef", request_bytes: 1_000, max_tokens: 100 },
      0,
      plan({ prices_usd_per_mtok: { ...PRICES, "@cf/cloudflare/clef": { in: 0.1, out: 0.2 } } }),
      { ...PRICES, "@cf/cloudflare/clef": { in: 0.1, out: 0.2 } },
    );
    expect(clef.answer.ok).toBe(true);
    expect(state.slots["trunk"]).toBeUndefined();
  });
});

describe("settle (SE6a)", () => {
  it("SE6a settle with usage charges the real cost and releases the rest of the bound", () => {
    const state = initialState(40);
    const granted = reserve(state, REQ, 0, plan(), PRICES);
    if (!granted.answer.ok) throw new Error("expected a granted reservation");
    // TL4: (5,000 x 0.35 + 1,000 x 0.75) / 1e6 = (1,750 + 750) / 1e6 = 0.0025. The bound was 0.006572.
    const { answer } = settle(
      state,
      { reservation_id: "r1", usage: { tokens_in: 5_000, tokens_out: 1_000 } },
      10,
      plan(),
      PRICES,
    );
    expect(answer).toEqual({ ok: true, charged_usd: expect.closeTo(0.0025), found: true });
    expect(state.spent_usd).toBeCloseTo(0.0025);
    expect(reservedTotal(state)).toBe(0);
  });

  it("SE6a settle with usage null charges the full bound", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    const { answer } = settle(state, { reservation_id: "r1", usage: null }, 10, plan(), PRICES);
    // Full bound 0.006572 — "settled without a usage report".
    expect(answer.charged_usd).toBeCloseTo(0.006572);
    expect(state.spent_usd).toBeCloseTo(0.006572);
  });

  it("SE6a a settle arriving at expires_at charges the full bound — not settled by expires_at", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    const { answer } = settle(
      state,
      { reservation_id: "r1", usage: { tokens_in: 1, tokens_out: 1 } },
      RESERVATION_TTL_MS,
      plan(),
      PRICES,
    );
    expect(answer.charged_usd).toBeCloseTo(0.006572);
  });

  it("SE6a a second settle of the same reservation changes nothing", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    settle(state, { reservation_id: "r1", usage: { tokens_in: 5_000, tokens_out: 1_000 } }, 10, plan(), PRICES);
    const again = settle(state, { reservation_id: "r1", usage: null }, 20, plan(), PRICES);
    expect(again.answer).toEqual({ ok: true, charged_usd: 0, found: false });
    expect(again.effects).toHaveLength(0);
    expect(state.spent_usd).toBeCloseTo(0.0025); // unchanged by the repeat
  });
});

describe("sweep (SE6a)", () => {
  it("SE6a an unsettled reservation is charged in full after expires_at", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    // expires_at is 70,000; at 70,000 the reservation was not settled by it.
    const { answer } = sweep(state, RESERVATION_TTL_MS, plan());
    expect(answer).toEqual({ ok: true, expired: 1 });
    expect(state.spent_usd).toBeCloseTo(0.006572); // the full bound 0.006572
    expect(reservedTotal(state)).toBe(0);
  });

  it("SE6a the sweep leaves a reservation whose expires_at is still ahead", () => {
    const state = initialState(40);
    reserve(state, REQ, 0, plan(), PRICES);
    const { answer } = sweep(state, RESERVATION_TTL_MS - 1, plan());
    expect(answer).toEqual({ ok: true, expired: 0 });
    expect(reservedTotal(state)).toBeCloseTo(0.006572);
  });
});

describe("spend cap (SE7)", () => {
  it("SE7 with cap 0.01 the first reservation that exceeds it is refused, refusing is true, nothing was reserved", () => {
    const state = initialState(0.01);
    const p = plan();
    registerPool(state, { pool: "p1" }, 0, p);
    // Bound 0.006572 fits: 0 + 0 + 0.006572 <= 0.01. The second reservation's 0.006572 does not:
    // 0 + 0.006572 + 0.006572 = 0.013144 > 0.01.
    const first = reserve(state, REQ, 0, p, PRICES);
    expect(first.answer.ok).toBe(true);
    const second = reserve(state, { ...REQ, attempt_id: "att-2" }, 10, p, PRICES);
    expect(second.answer).toEqual({ ok: false, refused: "spend_cap" });
    expect(state.refusing).toBe(true);
    expect(reservedTotal(state)).toBeCloseTo(0.006572); // only the first
    // SE9: the refusing flip emitted limits to the pool at once.
    const emit = emits(second.effects)[0];
    if (emit?.kind !== "emit") throw new Error("expected a limits emit on the refusing flip");
    expect(emit.event.refusing).toBe(true);
  });

  it("SE7 refusing is false again after an accepted reservation, and stays true across a killed refusal", () => {
    const state = initialState(0.01);
    const p = plan();
    registerPool(state, { pool: "p1" }, 0, p);
    reserve(state, REQ, 0, p, PRICES);
    expect(reserve(state, { ...REQ, attempt_id: "att-2" }, 0, p, PRICES).answer).toEqual({
      ok: false,
      refused: "spend_cap",
    });
    expect(state.refusing).toBe(true);
    // A killed refusal is not "refused for the cap": the flag is left alone (SE7 names only the
    // cap refusal and the accepted one).
    state.killed = true;
    expect(reserve(state, { ...REQ, attempt_id: "att-3" }, 0, p, PRICES).answer).toEqual({
      ok: false,
      refused: "killed",
    });
    expect(state.refusing).toBe(true);
    state.killed = false;
    // Settle the first reservation so spend frees budget under the cap, then accept again.
    settle(state, { reservation_id: "r1", usage: { tokens_in: 100, tokens_out: 10 } }, 0, p, PRICES);
    // spent = (100 x 0.35 + 10 x 0.75)/1e6 = 0.0000425; 0.0000425 + 0 + 0.006572 <= 0.01 -> accept.
    const accepted = reserve(state, { ...REQ, attempt_id: "att-3" }, 0, p, PRICES);
    expect(accepted.answer.ok).toBe(true);
    expect(state.refusing).toBe(false);
    // SE9: the flip back to false emitted limits at once, with the new value inside.
    const emit = emits(accepted.effects)[0];
    if (emit?.kind !== "emit") throw new Error("expected a limits emit on the refusing flip");
    expect(emit.event.refusing).toBe(false);
  });

  it("SE7 settled spend counts against the cap: spent + reserved + this > cap", () => {
    const state = initialState(0.01);
    const p = plan();
    reserve(state, REQ, 0, p, PRICES);
    settle(state, { reservation_id: "r1", usage: null }, 0, p, PRICES); // spent 0.006572
    // 0.006572 + 0 + 0.006572 > 0.01 -> refused even with nothing open.
    expect(reserve(state, { ...REQ, attempt_id: "att-2" }, 0, p, PRICES).answer).toEqual({
      ok: false,
      refused: "spend_cap",
    });
  });

  it("SE6a a model the price table does not name is refused spend_cap — no bound, fail closed", () => {
    const state = initialState(40);
    expect(amountOf({ ...REQ, model: "@cf/unknown" }, PRICES)).toBe(Number.POSITIVE_INFINITY);
    expect(reserve(state, { ...REQ, model: "@cf/unknown" }, 0, plan(), PRICES).answer).toEqual({
      ok: false,
      refused: "spend_cap",
    });
  });
});
