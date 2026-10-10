// 07-mcp MC20: an outside attempt's agent slot, claimed with no model call. Expected answers come
// from the rule text: the kill switch refuses first, a held slot is ok, a full gate answers the
// slot wait of MG5, and nothing is reserved.

import { describe, expect, it } from "vitest";
import type { ModelPlan } from "../../protocol/ports.ts";
import { initialState, realAgents, SLOT_RETRY_MS } from "./state.ts";
import { claim, mayStart, release } from "./rate.ts";

const plan: ModelPlan = {
  workhorse: "@cf/a",
  race: ["@cf/a"],
  per_minute: { "@cf/a": 60 },
  max_real_agents: 2,
  prices_usd_per_mtok: {},
};

describe("the gate's claim (07-mcp)", () => {
  it("MC20: a claim takes one agent slot and reserves no money", () => {
    const state = initialState(40);
    expect(claim(state, { attempt_id: "a_1", pool: "p" }, plan)).toEqual({ answer: { ok: true } });
    expect(realAgents(state)).toBe(1);
    expect(state.reservations).toEqual({});
    expect(state.spent_usd).toBe(0);
    expect(state.buckets).toEqual({});
  });

  it("MC20: a second claim of the same attempt is ok and takes no second slot", () => {
    const state = initialState(40);
    claim(state, { attempt_id: "a_1", pool: "p" }, plan);
    expect(claim(state, { attempt_id: "a_1", pool: "p" }, plan)).toEqual({ answer: { ok: true } });
    expect(realAgents(state)).toBe(1);
  });

  it("MC20: a full gate answers the slot wait, and a release frees the slot for the next claim", () => {
    const state = initialState(40);
    claim(state, { attempt_id: "a_1", pool: "p" }, plan);
    claim(state, { attempt_id: "a_2", pool: "p" }, plan);
    expect(claim(state, { attempt_id: "a_3", pool: "p" }, plan)).toEqual({
      answer: { ok: false, retry_after_ms: SLOT_RETRY_MS },
    });
    // The outside attempt's slots count against real agents like any other (MG5).
    expect(mayStart(state, {}, plan).ok).toBe(false);
    release(state, { attempt_id: "a_1" });
    expect(claim(state, { attempt_id: "a_3", pool: "p" }, plan)).toEqual({ answer: { ok: true } });
  });

  it("MC22: the kill switch refuses a claim before anything else", () => {
    const state = initialState(40);
    state.killed = true;
    expect(claim(state, { attempt_id: "a_1", pool: "p" }, plan)).toEqual({ answer: { ok: false, refused: "killed" } });
    expect(realAgents(state)).toBe(0);
  });
});
