// SE10, SE11, SE12: the kill switch and what the landings variant returns.

import { describe, expect, it } from "vitest";
import type { ModelPlan } from "../../protocol/ports.ts";
import { initialState } from "./state.ts";
import { setKilled } from "./kill.ts";
import { reserve, settle } from "./reserve.ts";
import { registerPool } from "./limits.ts";
import type { GateEffect } from "./types.ts";

const PRICES = { "@cf/a": { in: 0.35, out: 0.75 } };

const plan = (over: Partial<ModelPlan> = {}): ModelPlan => ({
  workhorse: "@cf/a",
  race: ["@cf/a"],
  per_minute: { "@cf/a": 240 },
  max_real_agents: 6,
  prices_usd_per_mtok: PRICES,
  ...over,
});

const REQ = { attempt_id: "att-1", pool: "p1", model: "@cf/a", request_bytes: 10_000, max_tokens: 4_096 };

function emits(effects: GateEffect[]) {
  return effects.filter((e) => e.kind === "emit");
}

describe("kill switch (SE10-SE12)", () => {
  it("SE10 after killed every reserve is refused with killed", () => {
    const state = initialState(40);
    const p = plan();
    setKilled(state, { killed: true }, 0, p);
    expect(reserve(state, REQ, 0, p, PRICES).answer).toEqual({ ok: false, refused: "killed" });
    expect(reserve(state, { ...REQ, attempt_id: "att-2" }, 0, p, PRICES).answer).toEqual({
      ok: false,
      refused: "killed",
    });
    // Nothing is reserved and nothing is spent.
    expect(Object.keys(state.reservations)).toHaveLength(0);
    expect(state.spent_usd).toBe(0);
  });

  it("SE11 a settle of an earlier reservation still works while killed", () => {
    const state = initialState(40);
    const p = plan();
    reserve(state, REQ, 0, p, PRICES);
    setKilled(state, { killed: true }, 0, p);
    const { answer } = settle(
      state,
      { reservation_id: "r1", usage: { tokens_in: 1_000, tokens_out: 100 } },
      10,
      p,
      PRICES,
    );
    // (1,000 x 0.35 + 100 x 0.75) / 1e6 = 425 / 1e6 = 0.000425 — the landing side of SE11 needs no model.
    expect(answer).toEqual({ ok: true, charged_usd: expect.closeTo(0.000425), found: true });
    expect(state.spent_usd).toBeCloseTo(0.000425);
  });

  it("SE11 the landings:false variant returns only the pause-pool-with-reason-owner effects", () => {
    const state = initialState(40);
    const p = plan();
    registerPool(state, { pool: "p1" }, 0, p);
    registerPool(state, { pool: "p2" }, 0, p);
    const { effects } = setKilled(state, { killed: true, landings: false }, 0, p);
    const pauses = effects.filter((e) => e.kind === "pause_pool");
    expect(pauses).toEqual([
      { kind: "pause_pool", pool: "p1", reason: "owner" },
      { kind: "pause_pool", pool: "p2", reason: "owner" },
    ]);
    // Every registered pool also got its limits at once (SE9: killed changed).
    expect(emits(effects)).toHaveLength(2);
  });

  it("SE12 killed is part of the state — it serialises, survives a restart and clears only on killed:false", () => {
    const state = initialState(40);
    const p = plan();
    registerPool(state, { pool: "p1" }, 0, p);
    setKilled(state, { killed: true }, 0, p);
    const restored = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(restored.killed).toBe(true);
    expect(reserve(restored, REQ, 0, p, PRICES).answer).toEqual({ ok: false, refused: "killed" });
    const { answer, effects } = setKilled(restored, { killed: false }, 0, p);
    expect(answer).toEqual({ ok: true, killed: false });
    // SE12 + SE9: resume effects carry the owner-reason guard, and the flip broadcast limits.
    expect(effects).toContainEqual({ kind: "resume_pool", pool: "p1", reason: "owner" });
    const emit = emits(effects)[0];
    if (emit?.kind !== "emit") throw new Error("expected a limits emit on the killed flip");
    expect(emit.event.killed).toBe(false);
    // And reserves run again.
    expect(reserve(restored, REQ, 0, p, PRICES).answer.ok).toBe(true);
  });

  it("SE10 a repeated killed:true changes nothing and emits nothing new — but landings:false still pauses", () => {
    const state = initialState(40);
    const p = plan();
    registerPool(state, { pool: "p1" }, 0, p);
    setKilled(state, { killed: true }, 0, p);
    const plain = setKilled(state, { killed: true }, 0, p);
    expect(plain.effects).toHaveLength(0); // no flip -> no broadcast, no landings asked
    const landing = setKilled(state, { killed: true, landings: false }, 0, p);
    expect(landing.effects).toEqual([{ kind: "pause_pool", pool: "p1", reason: "owner" }]);
  });
});
