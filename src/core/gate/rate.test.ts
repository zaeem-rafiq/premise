// SE8's token buckets and MG5's real-agent slots. Expected waits are worked from the rule text:
// "requests per minute" over 60,000 ms, rounded up.

import { describe, expect, it } from "vitest";
import type { ModelPlan } from "../../protocol/ports.ts";
import { initialState, SLOT_RETRY_MS } from "./state.ts";
import { bucketRate, mayStart, release, take, usedLastMinute } from "./rate.ts";

const plan = (over: Partial<ModelPlan> = {}): ModelPlan => ({
  workhorse: "@cf/a",
  race: ["@cf/a", "@cf/b"],
  per_minute: { "@cf/a": 2, "@cf/b": 60 },
  max_real_agents: 2,
  prices_usd_per_mtok: {},
  ...over,
});

describe("token bucket (SE8)", () => {
  it("SE8 grants up to per_minute calls, then answers retry_after_ms — never a refusal", () => {
    const state = initialState(40);
    const p = plan();
    expect(take(state, "@cf/a", 0, p)).toEqual({ ok: true });
    expect(take(state, "@cf/a", 0, p)).toEqual({ ok: true });
    // Rate 2/min refills 1 token per 30,000 ms; an empty bucket needs one full token:
    // ceil(1 * 60,000 / 2) = 30,000 ms.
    expect(take(state, "@cf/a", 0, p)).toEqual({ ok: false, retry_after_ms: 30_000 });
  });

  it("SE8 refills continuously: half a minute restores one token of a 2/min bucket", () => {
    const state = initialState(40);
    const p = plan();
    take(state, "@cf/a", 0, p);
    take(state, "@cf/a", 0, p);
    // tokens 0 at t=0; by t=30,000 the bucket holds exactly 1 again.
    expect(take(state, "@cf/a", 29_999, p)).toEqual({ ok: false, retry_after_ms: 1 });
    expect(take(state, "@cf/a", 30_000, p)).toEqual({ ok: true });
  });

  it("SE8 caps the bucket at per_minute: a quiet minute does not bank extra calls", () => {
    const state = initialState(40);
    const p = plan();
    take(state, "@cf/a", 0, p); // tokens 1 left
    // A whole day later the bucket refills to the capacity 2, not to 1 + a day's worth.
    expect(take(state, "@cf/a", 86_400_000, p)).toEqual({ ok: true });
    expect(take(state, "@cf/a", 86_400_000, p)).toEqual({ ok: true });
    expect(take(state, "@cf/a", 86_400_000, p)).toEqual({ ok: false, retry_after_ms: 30_000 });
  });

  it("SE8 gives Clef a bucket of its own: a spent workhorse bucket never slows a Clef call", () => {
    const p = plan({ per_minute: { "@cf/a": 1, "@cf/cloudflare/clef": 2 } });
    const state = initialState(40);
    take(state, "@cf/a", 0, p);
    // Rate 1/min: an empty bucket refills 1 token per 60,000 ms.
    expect(take(state, "@cf/a", 0, p)).toEqual({ ok: false, retry_after_ms: 60_000 });
    // Clef's bucket is keyed by its own model id and still full.
    expect(take(state, "@cf/cloudflare/clef", 0, p)).toEqual({ ok: true });
    expect(take(state, "@cf/cloudflare/clef", 0, p)).toEqual({ ok: true });
    // ceil(1 * 60,000 / 2) = 30,000.
    expect(take(state, "@cf/cloudflare/clef", 0, p)).toEqual({ ok: false, retry_after_ms: 30_000 });
  });

  it("SE8 does not rate-limit a model the plan's per_minute does not name", () => {
    const p = plan();
    const state = initialState(40);
    for (let i = 0; i < 100; i++) expect(take(state, "@cf/cloudflare/clef", i, p)).toEqual({ ok: true });
    expect(bucketRate("@cf/cloudflare/clef", p)).toBeNull();
    // And it is not given a bucket, so it cannot leak into the limits event's models.
    expect(usedLastMinute(state, "@cf/cloudflare/clef", 100)).toBe(0);
  });

  it("SE8 counts only the last minute in used_last_minute", () => {
    const state = initialState(40);
    const p = plan();
    take(state, "@cf/b", 0, p);
    take(state, "@cf/b", 30_000, p);
    // t=60,000: the call at 0 is exactly 60 s ago and still inside the window; t=60,001 it is out.
    expect(usedLastMinute(state, "@cf/b", 60_000)).toBe(2);
    expect(usedLastMinute(state, "@cf/b", 60_001)).toBe(1);
  });
});

describe("real-agent slots (MG5, SE8)", () => {
  it("MG5 mayStart answers the counts pool.state shows and whether a new loop may start", () => {
    const state = initialState(40);
    const p = plan();
    // max_real_agents 2, no slot held: ok, and the Floor reads 0 of 2.
    expect(mayStart(state, {}, p)).toEqual({ ok: true, real_agents: 0, max_real_agents: 2 });
    state.slots["att-1"] = { pool: "p1" };
    state.slots["att-2"] = { pool: "p1" };
    // Full: a third attempt waits — retry_after_ms, not a refusal.
    const no = mayStart(state, { attempt_id: "att-3" }, p);
    expect(no).toEqual({ ok: false, retry_after_ms: SLOT_RETRY_MS, real_agents: 2, max_real_agents: 2 });
    // The slot holder itself always may continue.
    expect(mayStart(state, { attempt_id: "att-2" }, p)).toEqual({ ok: true, real_agents: 2, max_real_agents: 2 });
  });

  it("MG5 release frees the slot and is idempotent", () => {
    const state = initialState(40);
    const p = plan();
    state.slots["att-1"] = { pool: "p1" };
    state.slots["att-2"] = { pool: "p1" };
    expect(release(state, { attempt_id: "att-1" }).answer).toEqual({ ok: true, released: true });
    expect(release(state, { attempt_id: "att-1" }).answer).toEqual({ ok: true, released: false });
    expect(mayStart(state, { attempt_id: "att-3" }, p)).toEqual({ ok: true, real_agents: 1, max_real_agents: 2 });
  });
});
