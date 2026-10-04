// Fixture replay (AC1, AC2, AC15, AC21, AC22, AC26, AC27, FE3, BP1): every stream of
// test/fixtures/streams/ is replayed through the shared reducer. Expected values are read off
// the `final` blocks of the vectors of docs/spec/premise-cases.json and off the mapping of
// 03-floor 4.3 — never off the reducer's own output.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import { EVENT_SOURCES } from "../events.ts";
import type { ReplayHeader } from "../replay.ts";
import { PUSH_STALL_MS, QUIET_NOTICE_MS, SPEND_NEAR_SHARE } from "../constants.ts";
import type { FloorState, LandingEntry, LandingView } from "./state.ts";
import { emptyFloorState, premiseId } from "./state.ts";
import { reduce } from "./reduce.ts";

const STREAMS = join(__dirname, "../../../test/fixtures/streams");
const FILES = readdirSync(STREAMS)
  .filter((name) => name.endsWith(".ndjson"))
  .sort();

/** Parses a Replay file (01-core 12.3): header on line 1, then `events` PoolEvent lines. */
function replayFile(name: string): { header: ReplayHeader; events: PoolEvent[] } {
  const text = readFileSync(join(STREAMS, name), "utf8");
  const lines = text.split("\n").filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  return { header, events };
}

function replay(events: PoolEvent[]): FloorState {
  return replayPrefix(events, events.length);
}

function replayPrefix(events: PoolEvent[], k: number): FloorState {
  const state = emptyFloorState();
  for (const event of events.slice(0, k)) reduce(state, event);
  return state;
}

/** The event count after the first event matching `pred`, for prefix replays. */
function after(events: PoolEvent[], pred: (event: PoolEvent) => boolean): number {
  const i = events.findIndex(pred);
  if (i < 0) throw new Error("event not found");
  return i + 1;
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a defined value");
  return value;
}

function view(entry: LandingEntry | undefined): LandingView {
  if (entry === undefined || entry.digest === true) throw new Error("expected a full LandingView");
  return entry;
}

// ---------------------------------------------------------------------------
// Recording validity (01-core 12.3, 03-floor 8.2/8.3): every file in the directory.
// ---------------------------------------------------------------------------

describe("every fixture file (01-core 12.3, 03-floor 8.2)", () => {
  it("finds the recorded streams of this slice", () => {
    expect(FILES).toContain("tracer.ndjson");
    expect(FILES).toContain("hero-c04.ndjson");
    expect(FILES).toContain("hero-c05.ndjson");
    expect(FILES.length).toBeGreaterThanOrEqual(26);
  });

  it.each(FILES)("%s: a premise_replay 2 header, then contiguous events from n = 1", (name) => {
    const { header, events } = replayFile(name);
    expect(header.premise_replay).toBe(2);
    expect(header.events).toBe(events.length);
    expect(typeof header.pool).toBe("string");
    expect(header.pool.length).toBeGreaterThan(0);
    expect(typeof header.recorded_at).toBe("string");
    expect(typeof header.synthetic).toBe("boolean");
    expect(typeof header.build).toBe("string");
    expect(typeof header.label).toBe("string");
    // 8.3's load checks: every event carries n, t, ts and type; t never decreases.
    let lastT = -Infinity;
    events.forEach((event, index) => {
      expect(event.n, `event ${index + 1} of ${name}`).toBe(index + 1);
      expect(typeof event.t).toBe("number");
      expect(typeof event.ts).toBe("number");
      expect(typeof event.type).toBe("string");
      expect(event.pool).toBe(header.pool);
      expect(EVENT_SOURCES).toContain(event.src);
      expect(event.t).toBeGreaterThanOrEqual(lastT);
      lastT = event.t;
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 / FE3: a snapshot join at every position gives the same FloorState.
// ---------------------------------------------------------------------------

describe("AC1/FE3: every snapshot position joins identically", () => {
  it.each(FILES)("%s: for every k the state equals the full replay, by deep equality", (name) => {
    const { events } = replayFile(name);
    const full = replay(events);
    expect(replay(events)).toStrictEqual(full); // a second live replay agrees (determinism)
    for (let k = 0; k <= events.length; k += 1) {
      const snapshot = replayPrefix(events, k);
      // The Floor's snapshot row is JSON: persist and restore before joining the tail.
      const joined = JSON.parse(JSON.stringify(snapshot)) as FloorState;
      for (const event of events.slice(k)) reduce(joined, event);
      expect(joined, `${name} joined at k=${k}`).toStrictEqual(full);
    }
  });
});

// ---------------------------------------------------------------------------
// The pinned Slice-1 fixtures.
// ---------------------------------------------------------------------------

describe("C04-hero-shared-rule-lands-first", () => {
  const { events } = replayFile("hero-c04.ndjson");
  const state = replay(events);

  it("C04 final: seq 1 is the shared rule (S), seq 2 the crab (A), head_seq 2", () => {
    expect(state.pool.head_seq).toBe(2);
    expect(state.pool.landed_seq).toBe(2);
    expect(state.counters.landed_changes).toBe(2);
    expect(state.landed_order).toEqual([2, 1]);
    expect(must(state.landings[1])).toMatchObject({
      kind: "change",
      attempt_id: "a_S",
      landed: { commit: "c044aaaa04c04c04c04c04c04c04c04c04c04c04" },
    });
    expect(must(state.landings[2])).toMatchObject({
      kind: "change",
      attempt_id: "a_A",
      landed: { commit: "c044bbbb04c04c04c04c04c04c04c04c04c04c04" },
    });
  });

  it("C04 final: both attempts landed; the crab went around once, the rule not at all", () => {
    expect(must(state.attempts.a_A)).toMatchObject({ state: "landed", go_arounds: 1, landed_seq: 2 });
    expect(must(state.attempts.a_S)).toMatchObject({ state: "landed", go_arounds: 0, landed_seq: 1 });
    expect(state.working_order).toEqual([]);
  });

  it("C04: the crab's ENERGY_MAX premise was judged repair by E2 and its heads-up resolved", () => {
    const attempt = must(state.attempts.a_A);
    const premise = must(attempt.premises[premiseId("entity", "world/energy.js#ENERGY_MAX")]);
    expect(premise.judgment).toMatchObject({ rule: "E2", result: "repair", cause_seq: 1 });
    expect(must(attempt.heads_ups[1])).toMatchObject({ result: "repair", go_around: 1 });
    expect(must(attempt.heads_ups[1]).resolved).toMatchObject({ changed: true });
    expect(premise.light).toBe("holds");
  });

  it("C04: FS2 — the last landing that changed each path", () => {
    expect(must(state.files["world/energy.js"]).last_landed_seq).toBe(1);
    expect(must(state.files["creatures/crab.js"]).last_landed_seq).toBe(2);
  });
});

describe("C05-hero-creature-lands-first", () => {
  const { events } = replayFile("hero-c05.ndjson");
  const state = replay(events);

  it("C05 final: seq 1 is the crab (A), seq 2 the shared rule (S), head_seq 2", () => {
    expect(state.pool.head_seq).toBe(2);
    expect(state.counters.landed_changes).toBe(2);
    expect(must(state.landings[1])).toMatchObject({ kind: "change", attempt_id: "a_A" });
    expect(must(state.landings[2])).toMatchObject({ kind: "change", attempt_id: "a_S" });
  });

  it("C05 final: both attempts landed; the rule went around once, the crab not at all", () => {
    expect(must(state.attempts.a_A)).toMatchObject({ state: "landed", go_arounds: 0 });
    expect(must(state.attempts.a_S)).toMatchObject({ state: "landed", go_arounds: 1 });
  });

  it("C05: S's refs query premise was judged repair by QR1, with the crab's entities added", () => {
    const attempt = must(state.attempts.a_S);
    const premise = must(attempt.premises[premiseId("query", "refs:world/energy.js#ENERGY_MAX")]);
    expect(premise.judgment).toMatchObject({ rule: "QR1", result: "repair", cause_seq: 1 });
    const item = must(must(attempt.heads_ups[1]).items?.[0]);
    expect(item.diff.kind).toBe("query");
    if (item.diff.kind === "query") {
      expect(item.diff.added.map((added) => added.key)).toEqual([
        "creatures/crab.js#(import ../world/energy.js)",
        "creatures/crab.js#spawn",
      ]);
      expect(item.diff.context.map((entry) => entry.key)).toEqual(["creatures/crab.js#update"]);
    }
  });
});

describe("tracer.ndjson", () => {
  const { events } = replayFile("tracer.ndjson");
  const state = replay(events);

  it("reduces every event type without an unknown_events count", () => {
    expect(state.unknown_events).toBe(0);
    expect(state.n).toBe(events.length);
  });

  it("the held card was opened and landed; undo then reverted seq 1", () => {
    expect(must(state.cards.k_T1).open).toBe(false);
    expect(must(state.landings[1]).undone_by).toBe(2);
    expect(must(state.landings[2])).toMatchObject({ kind: "undo", request_id: "r_1" });
    expect(must(state.undo.r_1)).toMatchObject({ target_seq: 1, landing_seq: 2 });
    expect(must(state.attempts.a_T)).toMatchObject({ reopened_by: "undo", revision: 2 });
  });

  it("pool.paused then a fresh pool.state returned the pool to ready", () => {
    expect(state.pool.state).toBe("ready");
    expect(state.push).toBeNull();
    expect(state.last_push).toEqual({ batch_id: 2, landings: 1, tries: 1, ms: 200 });
    expect(state.green).toMatchObject({ seq: 1, runtime: "isolate" });
    expect(state.swarm).toMatchObject({ running: true, ever_ran: true });
  });
});

// ---------------------------------------------------------------------------
// AC27: the go-around counters of GA1/GA3, on fixtures of vectors C39, C32, C47.
// ---------------------------------------------------------------------------

describe("C39-go-around-count-under-repeated-repairs (AC27, GA1)", () => {
  const { events } = replayFile("vector-c39.ndjson");
  const sState = (transition: string) =>
    replayPrefix(
      events,
      after(events, (e) => e.type === "attempt.state" && e.attempt_id === "a_S" && e.transition === transition),
    );

  it("GA1: T8 opens go-around 1; a joining repair (T10) adds 0; T10a adds 1 and grants right of way", () => {
    expect(sState("T8").counters.go_arounds).toBe(1);
    const joined = sState("T10");
    expect(joined.counters.go_arounds).toBe(1);
    expect(must(joined.attempts.a_S).go_arounds).toBe(1);
    const fresh = sState("T10a");
    expect(fresh.counters.go_arounds).toBe(2);
    const attempt = must(fresh.attempts.a_S);
    expect(attempt.go_arounds).toBe(2);
    expect(attempt.right_of_way).toBe(true); // sent_back 2 = STARVATION_AFTER (RW1)
  });

  it("RW3: the waiting candidate is skipped right_of_way, then not_disjoint, and goes around once", () => {
    const state = replay(events);
    const c4 = must(state.attempts.a_C4);
    expect(c4.state).toBe("going_around");
    expect(c4.go_arounds).toBe(1);
    expect(must(c4.heads_ups[1])).toMatchObject({ result: "repair", go_around: 1 });
    expect(state.counters.go_arounds).toBe(3); // S: two starts, C4: one
  });

  it("C39 final: head_seq 4; S landed with go_arounds 2", () => {
    const state = replay(events);
    expect(state.pool.head_seq).toBe(4);
    expect(state.counters.landed_changes).toBe(4);
    expect(must(state.attempts.a_S)).toMatchObject({ state: "landed", go_arounds: 2, landed_seq: 4 });
    expect(state.landed_order).toEqual([4, 3, 2, 1]);
  });
});

describe("C32-retry-resumes-classified (AC27, T21/GA1)", () => {
  const { events } = replayFile("vector-c32.ndjson");
  const t21 = after(events, (e) => e.type === "attempt.state" && e.attempt_id === "a_A" && e.transition === "T21");

  it("GL3a: parked and classified — heads-up 5 arrives while stopped and changes nothing", () => {
    const state = replayPrefix(
      events,
      after(events, (e) => e.type === "landing.landed" && e.seq === 5),
    );
    const attempt = must(state.attempts.a_A);
    expect(attempt.state).toBe("stopped");
    expect(attempt.stop_reason).toBe("go_around_limit");
    expect(attempt.go_arounds).toBe(3);
    expect(must(attempt.heads_ups[5])).toMatchObject({ result: "repair", wake: false, resolved: null });
    expect(state.counters.go_arounds).toBe(3);
  });

  it("AC27/4.3: 'Try again' (T21) adds 1 to the counter — a fresh go-around with right of way", () => {
    const before = replayPrefix(events, t21 - 1);
    expect(before.counters.go_arounds).toBe(3);
    const afterRetry = replayPrefix(events, t21);
    expect(afterRetry.counters.go_arounds).toBe(4);
    const attempt = must(afterRetry.attempts.a_A);
    expect(attempt.state).toBe("going_around");
    expect(attempt.go_arounds).toBe(1);
    expect(attempt.pull_backs).toBe(0);
    expect(attempt.right_of_way).toBe(true);
    expect(attempt.stop_reason).toBeNull();
    expect(attempt.reopened_by).toBe("retry");
    expect(attempt.revision).toBe(1);
    expect(must(afterRetry.cards.k_A1)).toMatchObject({ open: false, closed: { action: "retry", by: "owner" } });
  });

  it("C32 final: A lands as seq 6 with go_arounds 1; every missed heads-up resolved", () => {
    const state = replay(events);
    expect(state.pool.head_seq).toBe(6);
    const attempt = must(state.attempts.a_A);
    expect(attempt).toMatchObject({ state: "landed", go_arounds: 1, landed_seq: 6 });
    for (const hn of [1, 2, 3, 4, 5]) expect(must(attempt.heads_ups[hn]).resolved).not.toBeNull();
    expect(must(state.attempts.a_B5).state).toBe("landed");
  });
});

describe("C47-confirm-pull-backs-are-counted (AC27, GA3)", () => {
  const { events } = replayFile("vector-c47.ndjson");

  it("GA3: T11 pull-backs count in sent_back, never in the Go-arounds counter", () => {
    const state = replay(events);
    const attempt = must(state.attempts.a_A);
    expect(attempt.pull_backs).toBe(2);
    expect(attempt.go_arounds).toBe(0);
    // attempt.sent_back_n = go_arounds + pull_backs = 2 while the counter stayed 0.
    expect(state.counters.go_arounds).toBe(0);
    const b3 = must(state.attempts.a_B3);
    expect(b3.pull_backs).toBe(1);
    expect(b3.go_arounds).toBe(0);
    expect(b3.state).toBe("needs_confirm");
  });

  it("RW1/RW3: right of way engages at sent_back 2; B3 waits behind it", () => {
    const secondPull = replayPrefix(
      events,
      after(
        events,
        (e) => e.type === "attempt.state" && e.attempt_id === "a_A" && e.transition === "T11" && e.pull_backs === 2,
      ),
    );
    const attempt = must(secondPull.attempts.a_A);
    expect(attempt.state).toBe("needs_confirm");
    expect(attempt.right_of_way).toBe(true);
    const skip = events.find((e) => e.type === "tick.skipped" && e.attempt_id === "a_B3" && e.why === "right_of_way");
    expect(skip).toBeDefined();
  });

  it("C47 final: head_seq 3; A landed with pull_backs 2 and go_arounds 0", () => {
    const state = replay(events);
    expect(state.pool.head_seq).toBe(3);
    expect(must(state.attempts.a_A)).toMatchObject({ state: "landed", pull_backs: 2, go_arounds: 0, landed_seq: 3 });
  });
});

// ---------------------------------------------------------------------------
// AC26: EV6/FE4 — a summary_only pool reduces lean; a synthetic one reduces in full.
// ---------------------------------------------------------------------------

describe("pool-summary-only (AC26, EV6)", () => {
  const { events } = replayFile("pool-summary-only.ndjson");
  const state = replay(events);

  it("carries no premise, operation or step events at all", () => {
    expect(
      events.some((e) => e.type === "premise.recorded" || e.type === "op.recorded" || e.type === "attempt.step"),
    ).toBe(false);
  });

  it("reduces to attempts without premises, operations or steps", () => {
    expect(state.pool.summary_only).toBe(true);
    expect(state.pool.synthetic).toBe(true); // EM1a: pool.state before the first synthetic open
    const w1 = must(state.attempts.a_W1);
    expect(w1).toMatchObject({ agent: "synthetic", state: "landed", landed_seq: 1 });
    expect(Object.keys(w1.premises)).toHaveLength(0);
    expect(w1.ops).toHaveLength(0);
    expect(w1.steps).toBe(0);
    // The last heads-up is kept, without items; the note stays null.
    expect(must(must(state.attempts.a_W2).heads_ups[1]).items).toBeNull();
    expect(view(state.landings[1]).note).toBeNull();
    expect(view(state.landings[2]).note).toBeNull();
  });
});

describe("pool-synthetic (AC26, EM1a)", () => {
  const { events } = replayFile("pool-synthetic.ndjson");
  const state = replay(events);

  it("keeps premises, operations, heads-up items and notes under the SYNTHETIC banner", () => {
    expect(state.pool.synthetic).toBe(true);
    expect(state.pool.summary_only).toBe(false);
    const attempt = must(state.attempts.a_X);
    expect(attempt.agent).toBe("synthetic");
    expect(Object.keys(attempt.premises).length).toBeGreaterThan(0);
    expect(attempt.ops.length).toBeGreaterThan(0);
    expect(attempt.steps).toBe(2);
    expect(must(attempt.heads_ups[1]).items).toHaveLength(1);
    expect(view(state.landings[2]).note).not.toBeNull();
    expect(state.pool.head_seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC22: the card options of CD4, exactly and in order.
// ---------------------------------------------------------------------------

describe("card-held-minimal (AC22, HD1)", () => {
  const { events } = replayFile("card-held-minimal.ndjson");
  const state = replay(events);

  it("opens a held card in the minimal form and resolves it by land", () => {
    const view = must(state.cards.k_H1);
    expect(view.card.kind).toBe("held");
    expect(view.card.reason).toBe("held_path");
    expect(view.card.options.map((o) => o.id)).toEqual(["land", "decline"]);
    expect(view.card.preview).toBeNull();
    expect(view.card.risk).toBeNull();
    expect(Object.keys(view.card.blast_radius)).toHaveLength(0);
    expect(view.open).toBe(false);
    expect(view.closed).toMatchObject({ action: "land", by: "owner" });
    const attempt = must(state.attempts.a_H);
    expect(attempt.state).toBe("landed");
    expect(attempt.approved_ts).not.toBeNull(); // 4.3 card.closed: land sets approved_ts
  });
});

describe("card-choice-reopen-failed (AC22, CD4)", () => {
  const { events } = replayFile("card-choice-reopen-failed.ndjson");
  const state = replay(events);

  it("opens a choice card of reason reopen_failed with exactly the options new_attempt, stop", () => {
    const view = must(state.cards.k_R1);
    expect(view.card.kind).toBe("choice");
    expect(view.card.reason).toBe("reopen_failed");
    expect(view.card.options.map((o) => o.id)).toEqual(["new_attempt", "stop"]);
    expect(view.open).toBe(true);
    const attempt = must(state.attempts.a_A);
    expect(attempt).toMatchObject({
      state: "stopped",
      stop_reason: "reopen_failed",
      revision: 2,
      reopened_by: "revert",
    });
    // The revert it could not be reopened for is linked end to end.
    expect(must(state.landings[2])).toMatchObject({ kind: "revert", request_id: "r_rev" });
    expect(must(state.landings[1]).undone_by).toBe(2);
    expect(must(state.undo.r_rev)).toMatchObject({ cause: "revert", target_seq: 1, landing_seq: 2 });
  });
});

// ---------------------------------------------------------------------------
// AC21: GR3 — a first failed run shows nothing; the confirmed one shows banner 8.
// ---------------------------------------------------------------------------

describe("green-confirmed-fail (AC21, GR3)", () => {
  const { events } = replayFile("green-confirmed-fail.ndjson");
  const first = after(events, (e) => e.type === "green.verified" && e.confirmed === false);
  const second = after(events, (e) => e.type === "green.verified" && e.confirmed === true);

  it("the unconfirmed failure stores green.last and announces nothing", () => {
    const state = replayPrefix(events, first);
    expect(state.green.runtime).toBe("isolate");
    expect(state.green.last).toEqual({
      seq: 1,
      ok: false,
      confirmed: false,
      failed: [{ name: "visible", code: "visible:failed" }],
    });
    expect(Object.keys(state.undo)).toHaveLength(0); // no revert is announced yet
    expect(state.landings[1]?.undone_by).toBeNull();
  });

  it("the confirmed failure flips confirmed and the revert is queued (banner 8's state)", () => {
    const state = replayPrefix(events, second);
    expect(must(state.green.last)).toMatchObject({ seq: 1, ok: false, confirmed: true });
    const full = replay(events);
    expect(must(full.undo.r_g1)).toMatchObject({ cause: "revert", target_seq: 1, reverted: [1], reopened: ["a_G"] });
  });
});

// ---------------------------------------------------------------------------
// AC15: the stream-expressible failure rows of 03-floor 7.
// ---------------------------------------------------------------------------

describe("failure-row fixtures (AC15)", () => {
  it("fr01-model-slow: a working attempt is quiet past QUIET_NOTICE_MS", () => {
    const { events } = replayFile("fr01-model-slow.ndjson");
    const state = replay(events);
    const attempt = must(state.attempts.a_Q);
    expect(attempt.state).toBe("working");
    expect(state.ts - attempt.last_event_ts).toBeGreaterThanOrEqual(QUIET_NOTICE_MS);
  });

  it("fr02-step-failed: the newest step failed", () => {
    const state = replay(replayFile("fr02-step-failed.ndjson").events);
    expect(must(state.attempts.a_E).step).toMatchObject({ ok: false, error: "edit_conflict", tool: "write" });
  });

  it("fr03-submit-rejected: the submit was rejected and the attempt kept working", () => {
    const state = replay(replayFile("fr03-submit-rejected.ndjson").events);
    const attempt = must(state.attempts.a_R);
    expect(must(attempt.submit)).toMatchObject({ status: "rejected" });
    expect(attempt.state).toBe("working");
  });

  it("fr04-attempt-stopped: one stopped attempt per stop reason of the row", () => {
    const state = replay(replayFile("fr04-attempt-stopped.ndjson").events);
    const reasons = ["model_error", "tool_timeout", "stalled", "timeout", "budget", "spend_cap", "killed", "lost"];
    reasons.forEach((reason, i) => {
      expect(must(state.attempts[`a_${i}`])).toMatchObject({ state: "stopped", stop_reason: reason });
    });
  });

  it("fr05-push-retry: push stays non-null with the try, error and next try", () => {
    const state = replay(replayFile("fr05-push-retry.ndjson").events);
    expect(must(state.push)).toMatchObject({ batch_id: 1, tries: 1, error: "http_503" });
    expect(state.push?.next_try_ts).not.toBeNull();
    expect(must(state.attempts.a_P).state).toBe("accepted"); // still "Landing…"
  });

  it("fr06-push-stalled: the batch is still unpushed past PUSH_STALL_MS", () => {
    const state = replay(replayFile("fr06-push-stalled.ndjson").events);
    const push = must(state.push);
    expect(push.tries).toBe(2);
    expect(state.ts - push.first_accepted_ts).toBeGreaterThan(PUSH_STALL_MS);
  });

  it("fr07-spend-near: spend is at or over SPEND_NEAR_SHARE of the cap", () => {
    const state = replay(replayFile("fr07-spend-near.ndjson").events);
    const limits = must(state.limits);
    expect(limits.spend_usd).toBeGreaterThanOrEqual(limits.cap_usd * SPEND_NEAR_SHARE);
    expect(limits.refusing).toBe(false);
  });

  it("fr08-spend-cap: limits.refusing and an attempt stopped with spend_cap", () => {
    const state = replay(replayFile("fr08-spend-cap.ndjson").events);
    expect(must(state.limits).refusing).toBe(true);
    expect(must(state.attempts.a_C)).toMatchObject({ state: "stopped", stop_reason: "spend_cap" });
  });

  it("fr09-kill-switch: limits.killed and an attempt stopped with killed", () => {
    const state = replay(replayFile("fr09-kill-switch.ndjson").events);
    expect(must(state.limits).killed).toBe(true);
    expect(must(state.attempts.a_K)).toMatchObject({ state: "stopped", stop_reason: "killed" });
  });

  it("fr11-diverged: pool paused with reason diverged; the accepted change still waits", () => {
    const state = replay(replayFile("fr11-diverged.ndjson").events);
    expect(state.pool).toMatchObject({ state: "paused", reason: "diverged" });
    expect(must(state.attempts.a_P).state).toBe("accepted");
  });

  it("fr11-push-rejected: pool paused with reason push_rejected after the retries", () => {
    const state = replay(replayFile("fr11-push-rejected.ndjson").events);
    expect(state.pool).toMatchObject({ state: "paused", reason: "push_rejected" });
    expect(must(state.push)).toMatchObject({ tries: 3 });
  });

  it("fr12-note-seq-mismatch: pool paused with reason note_seq_mismatch", () => {
    const state = replay(replayFile("fr12-note-seq-mismatch.ndjson").events);
    expect(state.pool).toMatchObject({ state: "paused", reason: "note_seq_mismatch" });
  });

  it("fr13-owner-paused: pool paused with reason owner", () => {
    const state = replay(replayFile("fr13-owner-paused.ndjson").events);
    expect(state.pool).toMatchObject({ state: "paused", reason: "owner" });
  });

  it("fr14-rebuilding: state rebuilding with progress; the open card closed stale (RB5)", () => {
    const state = replay(replayFile("fr14-rebuilding.ndjson").events);
    expect(state.pool).toMatchObject({ state: "rebuilding", epoch: 2, rebuild: { done: 3, total: 10 } });
    expect(must(state.cards.k_H1)).toMatchObject({ open: false, closed: { action: "stale", by: "system" } });
  });

  it("fr16-go-around-limit: the attempt stopped at the limit and the choice card is open", () => {
    const state = replay(replayFile("fr16-go-around-limit.ndjson").events);
    expect(must(state.attempts.a_A)).toMatchObject({ state: "stopped", stop_reason: "go_around_limit", go_arounds: 3 });
    expect(must(state.cards.k_A1)).toMatchObject({ open: true });
    const card = must(state.cards.k_A1).card;
    expect(card).toMatchObject({ kind: "choice", reason: "go_around_limit" });
    expect(card.options.map((o) => o.id)).toEqual(["retry", "stop"]);
  });

  it("fr17-contradiction: a second E1 repair from another intent's landing opens the card", () => {
    const state = replay(replayFile("fr17-contradiction.ndjson").events);
    expect(must(state.attempts.a_A)).toMatchObject({ state: "stopped", stop_reason: "contradiction" });
    const card = must(state.cards.k_C1).card;
    expect(card).toMatchObject({ kind: "choice", reason: "contradiction", attempt_ids: ["a_A", "a_B2"] });
    expect(card.options.map((o) => o.id)).toEqual(["keep_landed", "retry"]);
  });

  it("fr26-slots-busy: real_agents at max and the new attempt still opened", () => {
    const state = replay(replayFile("fr26-slots-busy.ndjson").events);
    expect(state.pool).toMatchObject({ real_agents: 6, max_real_agents: 6 });
    expect(must(state.attempts.a_Q).state).toBe("opened");
  });

  it("fr27-unknown-event: the unknown type is counted and the stream keeps reducing", () => {
    const { events } = replayFile("fr27-unknown-event.ndjson");
    const state = replay(events);
    expect(state.unknown_events).toBe(1);
    expect(state.n).toBe(events.length);
    expect(must(state.attempts.a_A)).toMatchObject({ state: "working", step: { tool: "read" } });
  });
});
