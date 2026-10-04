// SE9, EV2a, EM6: the `limits` event to every registered pool, each pool's own `source_n`, the
// first one at registration, and the one-per-LIMITS_EVERY_MS throttle on spend changes.
// LIMITS_EVERY_MS is 1,000 (01-core Appendix C).

import { describe, expect, it } from "vitest";
import { LIMITS_EVERY_MS } from "../../protocol/constants.ts";
import type { ModelPlan } from "../../protocol/ports.ts";
import { initialState } from "./state.ts";
import { broadcast, limitsBody, limitsDue, flushLimits, registerPool, spendChanged } from "./limits.ts";
import type { GateEffect } from "./types.ts";

const plan = (over: Partial<ModelPlan> = {}): ModelPlan => ({
  workhorse: "@cf/a",
  race: ["@cf/a", "@cf/b"],
  per_minute: { "@cf/a": 240, "@cf/b": 16 },
  max_real_agents: 6,
  prices_usd_per_mtok: {},
  ...over,
});

function emitPools(effects: GateEffect[]): string[] {
  return effects.filter((e) => e.kind === "emit").map((e) => (e.kind === "emit" ? e.pool : ""));
}

describe("registration and source_n (EV2a, EM6)", () => {
  it("SE9 sends a pool its first limits at registration, source_n 1 under the state's epoch", () => {
    const state = initialState(40);
    const { effects } = registerPool(state, { pool: "p1" }, 5_000, plan());
    expect(effects).toHaveLength(1);
    const emit = effects[0];
    if (emit?.kind !== "emit") throw new Error("expected an emit effect");
    expect(emit.pool).toBe("p1");
    expect(emit.epoch).toBe(1);
    expect(emit.source_n).toBe(1);
    expect(emit.event).toMatchObject({
      pool: "p1",
      src: "gate",
      type: "limits",
      ts: 5_000,
      spend_usd: 0,
      reserved_usd: 0,
      cap_usd: 40,
      killed: false,
      refusing: false,
    });
    expect(emit.event.models).toEqual([
      { model: "@cf/a", per_minute: 240, used_last_minute: 0 },
      { model: "@cf/b", per_minute: 16, used_last_minute: 0 },
    ]);
  });

  it("EV2a gives two registered pools each their own source_n counter", () => {
    const state = initialState(40);
    registerPool(state, { pool: "p1" }, 0, plan());
    registerPool(state, { pool: "p2" }, 10, plan());
    const effects: GateEffect[] = [];
    broadcast(state, 20, plan(), effects);
    // p1 sent limits #1 at registration, p2 likewise; this broadcast is source_n 2 for both.
    const byPool = new Map(
      effects.filter((e) => e.kind === "emit").map((e) => (e.kind === "emit" ? [e.pool, e.source_n] : ["", 0])),
    );
    expect(byPool).toEqual(
      new Map([
        ["p1", 2],
        ["p2", 2],
      ]),
    );
    // And the pools' counters did not start over or share a sequence.
    expect(state.pools["p1"]?.source_n).toBe(2);
    expect(state.pools["p2"]?.source_n).toBe(2);
  });

  it("EV2a a repeated registerPool re-sends current limits under the next source_n and changes no membership", () => {
    const state = initialState(40);
    registerPool(state, { pool: "p1" }, 0, plan());
    const again = registerPool(state, { pool: "p1" }, 99, plan());
    expect(again.answer).toEqual({ ok: true, pool: "p1" });
    expect(Object.keys(state.pools)).toEqual(["p1"]);
    const emit = again.effects[0];
    if (emit?.kind !== "emit") throw new Error("expected an emit effect");
    expect(emit.source_n).toBe(2); // the retried registration repairs a lost first event
  });
});

describe("the throttle (SE9)", () => {
  it("SE9 broadcasts the first spend change at once, then holds changes to one per LIMITS_EVERY_MS", () => {
    const state = initialState(40);
    registerPool(state, { pool: "p1" }, 0, plan());
    const effects: GateEffect[] = [];
    spendChanged(state, 100, plan(), effects); // no broadcast yet -> immediate
    expect(emitPools(effects)).toEqual(["p1"]);
    expect(state.limits_at).toBe(100);
    spendChanged(state, 500, plan(), effects); // 400 < 1,000 inside the window -> held
    expect(effects).toHaveLength(1);
    expect(state.limits_dirty).toBe(true);
    expect(limitsDue(state, 500)).toEqual({ due: false, at: 1_100 });
    expect(limitsDue(state, 1_100)).toEqual({ due: true, at: 1_100 });
    flushLimits(state, 1_100, plan(), effects);
    expect(emitPools(effects)).toEqual(["p1", "p1"]);
    expect(state.limits_dirty).toBe(false);
    expect(limitsDue(state, 1_100)).toEqual({ due: false, at: null });
  });

  it("SE9 a second spend change inside the window keeps the one held-back event", () => {
    const state = initialState(40);
    registerPool(state, { pool: "p1" }, 0, plan());
    const effects: GateEffect[] = [];
    spendChanged(state, 0, plan(), effects);
    spendChanged(state, 100, plan(), effects);
    spendChanged(state, 200, plan(), effects);
    expect(effects).toHaveLength(1); // the window still owes exactly one flush
    expect(limitsDue(state, 999)).toEqual({ due: false, at: LIMITS_EVERY_MS });
  });

  it("SE9 a change with no registered pool leaves nothing to flush — registration still carries the totals", () => {
    const state = initialState(40);
    state.spent_usd = 3;
    const effects: GateEffect[] = [];
    spendChanged(state, 0, plan(), effects);
    expect(effects).toHaveLength(0);
    expect(state.limits_dirty).toBe(false);
    const { effects: reg } = registerPool(state, { pool: "p1" }, 5, plan());
    const emit = reg[0];
    if (emit?.kind !== "emit") throw new Error("expected an emit effect");
    expect(emit.event.spend_usd).toBe(3);
  });
});

describe("limitsBody", () => {
  it("EM6 carries spend, reserved, cap, killed and refusing — the fields of the 12.1 limits variant", () => {
    const state = initialState(10);
    state.spent_usd = 1.5;
    state.killed = true;
    state.refusing = true;
    state.reservations["r1"] = {
      id: "r1",
      attempt_id: "a",
      pool: "p1",
      model: "@cf/a",
      amount_usd: 0.25,
      expires_at: 9,
    };
    const body = limitsBody(state, "p1", 1_000, plan());
    expect(body).toMatchObject({
      spend_usd: 1.5,
      reserved_usd: 0.25, // the one open reservation's bound
      cap_usd: 10,
      killed: true,
      refusing: true,
    });
    expect(Object.keys(body).sort()).toEqual(
      ["cap_usd", "killed", "models", "pool", "refusing", "reserved_usd", "spend_usd", "src", "ts", "type"].sort(),
    );
  });
});
