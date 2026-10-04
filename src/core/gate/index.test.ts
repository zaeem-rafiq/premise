// The `apply` contract (item 6) and the acceptance cases of plan 2.5 items 3, 5 and 9 end to end:
// cap 0.01 (SE7), an unsettled reservation charged in full (SE6a), two pools each with their own
// `limits` sequence (EV2a, EM6), and settle-after-killed (SE10, SE11).

import { describe, expect, it } from "vitest";
import type { ModelPlan } from "../../protocol/ports.ts";
import { RESERVATION_TTL_MS } from "./state.ts";
import { apply, initialState, nextWakeup } from "./index.ts";
import type { GateEffect, GateResult } from "./types.ts";

const PRICES = { "@cf/a": { in: 0.35, out: 0.75 }, "@cf/b": { in: 0.95, out: 4.0 } };

const plan = (over: Partial<ModelPlan> = {}): ModelPlan => ({
  workhorse: "@cf/a",
  race: ["@cf/a", "@cf/b"],
  per_minute: { "@cf/a": 240, "@cf/b": 16 },
  max_real_agents: 2,
  prices_usd_per_mtok: PRICES,
  ...over,
});

const REQ = { attempt_id: "att-1", pool: "p1", model: "@cf/a", request_bytes: 10_000, max_tokens: 4_096 };

function emits(result: GateResult) {
  return result.effects.filter((e) => e.kind === "emit");
}

describe("apply: the whole protocol", () => {
  it("SE6a (item 5) an unsettled reservation is charged in full after expires_at", () => {
    const p = plan();
    let result = apply(initialState(40), { call: "reserve", request: REQ }, 0, p, PRICES);
    expect(result.answer).toEqual({ ok: true, reservation_id: "r1", expires_at: RESERVATION_TTL_MS });
    // The alarm asks for the expiry moment.
    expect(nextWakeup(result.state, 0)).toBe(RESERVATION_TTL_MS);
    result = apply(result.state, { call: "sweep" }, RESERVATION_TTL_MS + 1, p, PRICES);
    expect(result.answer).toEqual({ ok: true, expired: 1 });
    // Bound by hand: (10,000 x 0.35 + 4,096 x 0.75) / 1e6 = 0.006572 — charged in full.
    expect(result.state.spent_usd).toBeCloseTo(0.006572);
  });

  it("SE7 (item 3) cap 0.01: the first reservation that exceeds it is refused, refusing is true, nothing was reserved", () => {
    const p = plan();
    let result = apply(initialState(0.01), { call: "register-pool", request: { pool: "p1" } }, 0, p, PRICES);
    result = apply(result.state, { call: "reserve", request: REQ }, 0, p, PRICES); // 0.006572 fits
    expect(result.answer).toMatchObject({ ok: true });
    result = apply(result.state, { call: "reserve", request: { ...REQ, attempt_id: "att-2" } }, 0, p, PRICES);
    expect(result.answer).toEqual({ ok: false, refused: "spend_cap" });
    expect(result.state.refusing).toBe(true);
    expect(result.state.reservations["r2"]).toBeUndefined(); // only r1 ever existed
    expect(Object.keys(result.state.reservations)).toEqual(["r1"]);
  });

  it("EV2a + EM6 (item 9) two registered pools each receive limits with their own source_n, first at registration", () => {
    const p = plan();
    const r1 = apply(initialState(40), { call: "register-pool", request: { pool: "p1" } }, 0, p, PRICES);
    const e1 = emits(r1)[0];
    if (e1?.kind !== "emit") throw new Error("expected an emit");
    expect([e1.pool, e1.source_n]).toEqual(["p1", 1]);
    const r2 = apply(r1.state, { call: "register-pool", request: { pool: "p2" } }, 10, p, PRICES);
    const e2 = emits(r2)[0];
    if (e2?.kind !== "emit") throw new Error("expected an emit");
    expect([e2.pool, e2.source_n]).toEqual(["p2", 1]); // p2's own counter starts at 1
    // A killed flip broadcasts to both, each at its own next source_n.
    const r3 = apply(r2.state, { call: "kill", request: { killed: true } }, 20, p, PRICES);
    const got = new Map(emits(r3).map((e) => (e.kind === "emit" ? [e.pool, e.source_n] : ["", 0])));
    expect(got).toEqual(
      new Map([
        ["p1", 2],
        ["p2", 2],
      ]),
    );
    for (const e of emits(r3)) if (e.kind === "emit") expect(e.event.killed).toBe(true);
  });

  it("SE10 + SE11 after killed every reserve is refused and a settle of an earlier reservation still works", () => {
    const p = plan();
    let result = apply(initialState(40), { call: "reserve", request: REQ }, 0, p, PRICES);
    result = apply(result.state, { call: "kill", request: { killed: true } }, 10, p, PRICES);
    const refused = apply(result.state, { call: "reserve", request: { ...REQ, attempt_id: "att-2" } }, 20, p, PRICES);
    expect(refused.answer).toEqual({ ok: false, refused: "killed" });
    const settled = apply(
      result.state,
      { call: "settle", request: { reservation_id: "r1", usage: { tokens_in: 2_000, tokens_out: 400 } } },
      30,
      p,
      PRICES,
    );
    // (2,000 x 0.35 + 400 x 0.75) / 1e6 = (700 + 300) / 1e6 = 0.001.
    expect(settled.answer).toEqual({ ok: true, charged_usd: expect.closeTo(0.001), found: true });
  });

  it("SE8 (item 4) may-start holds the third of three intents in opened at max_real_agents 2", () => {
    const p = plan(); // max_real_agents 2
    let state = initialState(40);
    for (const attempt_id of ["a1", "a2"]) {
      const r = apply(state, { call: "reserve", request: { ...REQ, attempt_id } }, 0, p, PRICES);
      expect(r.answer).toMatchObject({ ok: true });
      state = r.state;
    }
    expect(apply(state, { call: "may-start", request: {} }, 0, p, PRICES).answer).toEqual({
      ok: false,
      retry_after_ms: 2_000,
      real_agents: 2,
      max_real_agents: 2,
    });
    // A release frees the slot — the waiting attempt may start.
    state = apply(state, { call: "release", request: { attempt_id: "a1" } }, 0, p, PRICES).state;
    expect(apply(state, { call: "may-start", request: {} }, 0, p, PRICES).answer).toMatchObject({
      ok: true,
      real_agents: 1,
    });
  });

  it("apply never mutates the state it was given, and the returned state is JSON-clean", () => {
    const p = plan();
    const state = initialState(40);
    const before = JSON.stringify(state);
    const result = apply(state, { call: "reserve", request: REQ }, 0, p, PRICES);
    expect(JSON.stringify(state)).toBe(before); // the stored value is untouched
    expect(result.state).not.toBe(state);
    expect(() => JSON.stringify(result.state)).not.toThrow();
    // A second apply on the same stored state replays the same decision (idempotent storage story).
    const again = apply(state, { call: "reserve", request: REQ }, 0, p, PRICES);
    expect(again.answer).toEqual(result.answer);
  });

  it("sweep answers expired counts and flushes a due throttled limits", () => {
    const p = plan();
    let state = apply(initialState(40), { call: "register-pool", request: { pool: "p1" } }, 0, p, PRICES).state;
    const a = apply(state, { call: "reserve", request: REQ }, 0, p, PRICES);
    state = a.state;
    expect(emits(a)).toHaveLength(1); // first spend change goes out at once
    const b = apply(state, { call: "reserve", request: { ...REQ, attempt_id: "a2" } }, 100, p, PRICES);
    expect(emits(b)).toHaveLength(0); // throttled: 100 < 1,000
    expect(nextWakeup(b.state, 100)).toBe(1_000); // the held limits beats any expiry
    const s = apply(b.state, { call: "sweep" }, 1_000, p, PRICES);
    expect(s.answer).toEqual({ ok: true, expired: 0 });
    expect(emits(s)).toHaveLength(1); // the held-back broadcast, with both reservations inside
    const e = emits(s)[0];
    if (e?.kind !== "emit") throw new Error("expected an emit");
    expect(e.event.reserved_usd).toBeCloseTo(2 * 0.006572);
    expect(e.source_n).toBe(3);
  });
});
