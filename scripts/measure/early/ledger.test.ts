// The local ledger of ME4/SE6a: reservations bounded by request bytes + max_tokens before a call
// goes out, settlement at real usage (full reservation when no usage came back), the --max-usd cap
// and the per_minute rate meter of MG2's model plan.

import { describe, it, expect } from "vitest";
import { newLedger, reservationBound, settleAmount, MODEL_PLAN } from "./ledger.ts";

const MODEL = "@cf/zai-org/glm-5.3-flash"; // input 0.15, output 0.5 per million
const price = MODEL_PLAN[MODEL]!.price;

describe("SE6 reservation arithmetic", () => {
  it("the bound is request_bytes at input price plus max_tokens at output price, per million", () => {
    expect(reservationBound(10_000, 500, price)).toBeCloseTo((10_000 * 0.15 + 500 * 0.5) / 1e6, 12);
  });

  it("settle charges real usage; with no usage it charges the whole reservation (SE6a)", () => {
    const bound = reservationBound(10_000, 500, price);
    expect(settleAmount(bound, { tokens_in: 200, tokens_out: 100 }, price)).toBeCloseTo(
      (200 * 0.15 + 100 * 0.5) / 1e6,
      12,
    );
    expect(settleAmount(bound, null, price)).toBe(bound);
  });
});

describe("the bounded ledger (--max-usd, ME4)", () => {
  it("reserve returns null when the bound on top of spend and open reservations would pass the cap", () => {
    const l = newLedger({ maxUsd: 0.000_001 });
    expect(l.reserve(MODEL, 1_000_000, 1_000_000)).toBeNull();
    expect(l.outstandingUsd()).toBe(0);
  });

  it("a settled call moves spend from outstanding to spentUsd", () => {
    const l = newLedger({ maxUsd: 1 });
    const r = l.reserve(MODEL, 10_000, 500);
    expect(r).not.toBeNull();
    const amount = l.settle(r!.id, { tokens_in: 200, tokens_out: 100 });
    expect(amount).toBeCloseTo((200 * 0.15 + 100 * 0.5) / 1e6, 12);
    expect(l.spentUsd()).toBeCloseTo(amount, 12);
    expect(l.outstandingUsd()).toBe(0);
  });

  it("an unsettled reservation still counts against headroom", () => {
    const l = newLedger({ maxUsd: 0.001 });
    const big = l.reserve(MODEL, 100_000, 10_000); // bound ~0.02 > cap
    expect(big).toBeNull();
    const small = l.reserve(MODEL, 1000, 100);
    expect(small).not.toBeNull();
    expect(l.headroomUsd()).toBeCloseTo(0.001 - small!.bound, 12);
  });

  it("settling a full reservation when usage never came back (SE6a)", () => {
    const l = newLedger({ maxUsd: 1 });
    const r = l.reserve(MODEL, 10_000, 500)!;
    expect(l.settle(r.id, null)).toBe(r.bound);
    expect(l.spentUsd()).toBe(r.bound);
  });
});

describe("the per_minute rate meter (MG2)", () => {
  it("rateLimited goes true at the plan's per_minute, and falls back to 60 for unknown models", () => {
    const l = newLedger({ maxUsd: 1 });
    for (let i = 0; i < 16; i++) l.noteCall(MODEL, i * 1000);
    expect(l.rateLimited(MODEL, 16_000)).toBe(true);
    // sliding window: calls older than 60s stop counting (t in 11000..15000 still count)
    expect(l.callsInLastMinute(MODEL, 70_000)).toBe(5);
    expect(l.rateLimited(MODEL, 70_000)).toBe(false);
    for (let i = 0; i < 60; i++) l.noteCall("other-model", i * 100);
    expect(l.rateLimited("other-model", 6_000)).toBe(true);
  });
});
