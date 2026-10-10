// Unit tests of the derived values of 03-floor 4.4, the banner order of 3.18 and the strip
// cells of 3.8. Includes the AC3 (FL3) proof on the real tracer stream: `landing.accepted`
// with no `landing.landed` says "Landing…", moves no landed counter or frame commit, and
// offers no Why card. Expected values come from the fixture's own events.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUSH_STALL_MS, SPEND_NEAR_SHARE } from "../../protocol/constants.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import { reduce } from "../../protocol/reducer/reduce.ts";
import { emptyFloorState, type FloorState } from "../../protocol/reducer/state.ts";
import { text } from "../../copy/strings.ts";
import {
  bannerList,
  greenRed,
  pushStalled,
  quietPool,
  runClock,
  sentBack,
  statusWordId,
  stripCells,
  whyOffered,
} from "./derive.ts";

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/streams");

function stream(name: string, through?: number): FloorState {
  const lines = readFileSync(join(STREAMS, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const state = emptyFloorState();
  for (const line of lines.slice(1, through === undefined ? undefined : through + 1)) {
    reduce(state, JSON.parse(line) as PoolEvent);
  }
  return state;
}

const LIVE = {
  replay: { active: false, synthetic: false, title: "", date: "" },
  view: "floor" as const,
  connection: "open" as const,
  connectionTries: 0,
  staleFor: null,
  owner: false,
};

describe("4.4 runClock", () => {
  it("is null before the first intent.created, then clock minus its ts", () => {
    const before = stream("tracer", 2);
    expect(runClock(before, 9_999_999)).toBeNull();
    const state = stream("tracer", 3); // n=3 is the first intent.created
    expect(state.first_intent_ts).not.toBeNull();
    expect(runClock(state, state.first_intent_ts! + 65_000)).toBe(65_000);
  });
});

describe("AC3 (FL3): landing.accepted with no landing.landed", () => {
  // The tracer's event 23 is `landing.accepted` seq 1; its `landing.landed` is event 26.
  const accepted = stream("tracer", 23);
  const attempt = accepted.attempts["a_T"]!;
  const landing = accepted.landings[1]!;

  it("the attempt shows status.accepted - the copy id for 'Landing…'", () => {
    expect(statusWordId(attempt, accepted)).toBe("status.accepted");
    expect(text("status.accepted")).toBe("Landing…");
    // The same after the attempt.state event to `accepted` (n=24).
    const state = stream("tracer", 24);
    expect(statusWordId(state.attempts["a_T"]!, state)).toBe("status.accepted");
  });

  it("an attempt.state to `landed` before landing.landed still says Landing…", () => {
    // FL3 pins the word to the landing event, not to the attempt's own state word.
    const state = stream("tracer", 25); // landed_seq set, landing.landed not yet arrived
    const attempt = state.attempts["a_T"]!;
    expect(statusWordId(attempt, state)).not.toBe("status.landed");
  });

  it("the Landed counter does not move: counters.landed_changes stays 0", () => {
    expect(accepted.counters.landed_changes).toBe(0);
    const landed = stream("tracer", 26); // n=26: landing.landed seq 1
    expect(landed.counters.landed_changes).toBe(1);
    expect(statusWordId(landed.attempts["a_T"]!, landed)).toBe("status.landed");
  });

  it("the pool frame's commit does not move: pool.landed_commit stays the seed's", () => {
    const seed = stream("tracer", 1).pool.landed_commit;
    expect(accepted.pool.landed_commit).toBe(seed);
    const landed = stream("tracer", 26);
    expect(landed.pool.landed_commit).not.toBe(seed);
  });

  it("the landing offers no Why card: landing.landed is null (whyOffered)", () => {
    expect(landing.digest).not.toBe(true);
    expect(whyOffered(landing)).toBe(false);
    const landed = stream("tracer", 26);
    expect(whyOffered(landed.landings[1]!)).toBe(true);
  });
});

describe("4.4 sentBack / pushStalled / greenRed / quietPool", () => {
  it("sentBack is go_arounds + pull_backs (01-core GA3)", () => {
    const state = emptyFloorState();
    state.attempts["a_1"] = {
      ...emptyAttempt(),
      go_arounds: 2,
      pull_backs: 1,
    };
    expect(sentBack(state.attempts["a_1"]!)).toBe(3);
  });

  it("pushStalled only after PUSH_STALL_MS of pending push", () => {
    const state = stream("tracer", 24); // landing.accepted at n=23 starts `push`
    const first = state.push!.first_accepted_ts;
    expect(pushStalled(state, first + PUSH_STALL_MS)).toBe(false);
    expect(pushStalled(state, first + PUSH_STALL_MS + 1)).toBe(true);
    expect(pushStalled(stream("tracer", 27), first + PUSH_STALL_MS + 1)).toBe(false); // batch.pushed n=27 clears `push`
  });

  it("greenRed: a confirmed failed check with no revert landed", () => {
    const state = emptyFloorState();
    expect(greenRed(state)).toBe(false);
    state.green.last = { seq: 4, ok: false, confirmed: true, failed: [{ name: "selftest", code: "x" }] };
    expect(greenRed(state)).toBe(true);
    state.green.last = { seq: 4, ok: false, confirmed: false, failed: [] };
    expect(greenRed(state)).toBe(false);
  });

  it("FR19: only a confirmed failure announces the revert, and its banner leaves when the revert lands", () => {
    const first = stream("green-confirmed-fail", 17);
    const firstCell = stripCells(first, first.ts, { greenFeature: "full" }).find((cell) => cell.id === "strip.green");
    expect(firstCell?.value).toBe("checking landing 1 again");
    expect(bannerList(first, first.ts, LIVE).some((row) => row.id === "banner.green_red")).toBe(false);
    expect(Object.keys(first.undo)).toEqual([]);

    const second = stream("green-confirmed-fail", 18);
    expect(
      stripCells(second, second.ts, { greenFeature: "full" }).find((cell) => cell.id === "strip.green")?.value,
    ).toBe("failed at landing 1");
    expect(bannerList(second, second.ts, LIVE).find((row) => row.id === "banner.green_red")?.sentence).toBe(
      "The check failed twice at landing 1: Every creature can be seen.",
    );

    const state = stream("green-confirmed-fail");
    expect(state.undo.r_g1).toMatchObject({ cause: "revert", reverted: [1], reopened: ["a_G"] });
    expect(bannerList(state, state.ts, LIVE).find((row) => row.id === "banner.green_red")?.sentence).toBe(
      "The check failed twice at landing 1: Every creature can be seen. Trunk is taking back landing 1 and reopening their agents.",
    );
    const base = { pool: "tidepool", src: "trunk" as const, ts: state.ts + 100, t: state.ts + 105 };
    reduce(state, {
      ...base,
      n: 20,
      type: "landing.accepted",
      seq: 2,
      batch_id: 2,
      kind: "revert",
      attempt_id: null,
      change_id: "c-revert-1",
      intent_id: null,
      request_id: "r_g1",
      paths: ["creatures/crab.js"],
      writes: [{ kind: "entity", key: "creatures/crab.js#spawn", old: "h-crab-spawn", new: "absent" }],
    });
    expect(state.landings[2]?.kind).toBe("revert");
    expect(bannerList(state, state.ts, LIVE).some((row) => row.id === "banner.green_red")).toBe(true);
    reduce(state, {
      ...base,
      n: 21,
      type: "landing.landed",
      seq: 2,
      batch_id: 2,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      note: "a".repeat(40),
      note_json: null,
      time_to_land_ms: 100,
    });
    expect(bannerList(state, state.ts, LIVE).some((row) => row.id === "banner.green_red")).toBe(false);
    expect(state.landings[1]?.undone_by).toBe(2);
    reduce(state, {
      ...base,
      n: 22,
      type: "attempt.reopened",
      attempt_id: "a_G",
      cause: "revert",
      revision: 1,
      model_changed: false,
    });
    expect(state.working_order).toContain("a_G");
    expect(state.attempts.a_G).toMatchObject({ reopened_by: "revert", landed_seq: null, revision: 1 });
  });

  it("quietPool (RY23): no attempt in flight and no landing in the last 60 s", () => {
    const state = stream("tracer", 1); // pool.state only: quiet
    expect(quietPool(state, state.ts + 61_000)).toBe(true);
    const busy = stream("tracer", 6); // attempt a_T opened
    expect(quietPool(busy, busy.ts + 61_000)).toBe(false);
    const landed = stream("tracer", 25);
    expect(quietPool(landed, landed.ts + 10_000)).toBe(false); // landing within 60 s
    expect(quietPool(landed, landed.ts + 70_000)).toBe(true);
  });

  it("FR19: a compacted revert clears the banner only after landing, never for a newer failure", () => {
    const state = stream("green-confirmed-fail");
    state.landings[2] = {
      digest: true,
      seq: 2,
      kind: "revert",
      batch_id: 2,
      attempt_id: null,
      change_id: "c-revert-1",
      intent_id: null,
      request_id: "r_g1",
      paths: ["creatures/crab.js"],
      premise_keys: [],
      accepted_ts: state.ts,
      landed_ts: null,
      commit: null,
      tree: null,
      undone_by: null,
    };
    state.landed_order.unshift(2);
    expect(greenRed(state)).toBe(true);
    reduce(state, {
      pool: "tidepool",
      src: "trunk",
      ts: state.ts + 100,
      t: state.ts + 105,
      n: 20,
      type: "landing.landed",
      seq: 2,
      batch_id: 2,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      note: "a".repeat(40),
      note_json: null,
      time_to_land_ms: 100,
    });
    expect(greenRed(state)).toBe(false);
    for (const seq of [2, 3]) {
      state.green.last = { seq, ok: false, confirmed: true, failed: [{ name: "selftest", code: "x" }] };
      expect(greenRed(state)).toBe(true);
    }
  });
});

describe("3.8 strip cells", () => {
  const OPTS = { greenFeature: "none" as const };

  it("before the first event every value is strip.dash (3.8 loading)", () => {
    const cells = stripCells(emptyFloorState(), 0, OPTS);
    for (const cell of cells) {
      expect([text("strip.dash"), text("green.none"), text("spend.unknown")]).toContain(cell.value);
    }
  });

  it("agents reads {n} of {max} from pool.real_agents / pool.max_real_agents", () => {
    const state = stream("tracer", 6);
    const cell = stripCells(state, state.ts, OPTS).find((c) => c.id === "strip.agents")!;
    expect(cell.value).toBe(`${state.pool.real_agents} of ${state.pool.max_real_agents}`);
  });

  it("in a synthetic pool with no real attempt in flight the cell counts scripted agents (CO30)", () => {
    const state = stream("tracer", 1);
    state.pool.synthetic = true;
    state.attempts["a_S"] = { ...emptyAttempt(), agent: "synthetic" };
    const cell = stripCells(state, state.ts, OPTS).find((c) => c.id === "strip.agents")!;
    expect(cell.value).toBe(text("strip.agents.synthetic", { n: 1 }));
  });

  it("the landed cell counts landed changes only (FL3)", () => {
    expect(stripCells(stream("tracer", 22), 0, OPTS).find((c) => c.id === "strip.landed")!.value).toBe("0");
    // The tracer's seq 2 is an undo landing: the cell counts kind `change` only (3.8).
    expect(stripCells(stream("tracer", 44), 0, OPTS).find((c) => c.id === "strip.landed")!.value).toBe("1");
  });

  it("the spend cell marks near and reached (3.18)", () => {
    const state = stream("tracer", 8); // limits event at n=8
    const cap = state.limits!.cap_usd;
    state.limits!.spend_usd = cap * SPEND_NEAR_SHARE;
    expect(stripCells(state, state.ts, OPTS).find((c) => c.id === "strip.spend")!.tone).toBe("confirm");
    state.limits!.refusing = true;
    expect(stripCells(state, state.ts, OPTS).find((c) => c.id === "strip.spend")!.tone).toBe("changed");
  });
});

describe("3.18 banners", () => {
  it("a synthetic pool always sits under banner.synthetic (FL4)", () => {
    const state = emptyFloorState();
    state.pool.synthetic = true;
    const rows = bannerList(state, 0, LIVE);
    expect(rows[0]!.id).toBe("banner.synthetic");
    expect(rows[0]!.word).toBe("SYNTHETIC");
  });

  it("Replay always sits under banner.replay, first after synthetic (RY3)", () => {
    const state = emptyFloorState();
    const rows = bannerList(state, 0, {
      ...LIVE,
      replay: { active: true, synthetic: true, title: "tracer", date: "2026-01-01" },
    });
    expect(rows.map((r) => r.id)).toEqual(["banner.synthetic", "banner.replay"]);
  });

  it("the order follows the table: killed, paused, rebuilding, cap, push, green_red, offline", () => {
    const state = emptyFloorState();
    state.limits = {
      spend_usd: 1,
      reserved_usd: 0,
      cap_usd: 10,
      killed: true,
      refusing: true,
      ts: 0,
      models: [],
    };
    state.pool.state = "paused";
    state.pool.reason = "owner";
    state.push = { batch_id: 1, first_accepted_ts: 0, tries: 1, error: null, next_try_ts: 1_000 };
    state.green.last = { seq: 2, ok: false, confirmed: true, failed: [{ name: "selftest", code: "x" }] };
    const rows = bannerList(state, PUSH_STALL_MS + 1, { ...LIVE, connection: "lost", connectionTries: 3 });
    expect(rows.map((r) => r.id)).toEqual([
      "banner.killed.landings", // killed with landings paused (5.11)
      "banner.paused.owner",
      "banner.cap",
      "banner.push",
      "banner.green_red",
      "banner.offline",
    ]);
  });

  it("pool.paused reasons map to their own sentences (FR11 to FR13)", () => {
    for (const [reason, id] of [
      ["diverged", "banner.paused.diverged"],
      ["push_rejected", "banner.paused.push_rejected"],
      ["note_seq_mismatch", "banner.paused.note_seq_mismatch"],
      ["owner", "banner.paused.owner"],
    ] as const) {
      const state = emptyFloorState();
      state.pool.state = "paused";
      state.pool.reason = reason;
      expect(bannerList(state, 0, LIVE).map((r) => r.id)).toEqual([id]);
    }
  });

  it("a lost connection shows banner.offline last (FR10)", () => {
    const state = emptyFloorState();
    const rows = bannerList(state, 0, { ...LIVE, connection: "lost", connectionTries: 2, staleFor: 4_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("banner.offline");
    expect(rows[0]!.sentence).toBe(text("banner.offline", { n: 2, duration: "4 s" }));
  });
});

function emptyAttempt() {
  return {
    id: "a_1",
    intent_id: "i_1",
    change_id: "",
    agent: "real" as const,
    model: null,
    race: false,
    state: "working" as const,
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
    revision: 1,
    reopened_by: null,
    model_changed: false,
    opened_ts: 0,
    last_event_ts: 0,
    step: null,
    steps: 0,
    premises: {},
    ops: [],
    heads_ups: {},
    submit: null,
    repair_open_ts: null,
    skipped: null,
    card_id: null,
    approved_ts: null,
    landed_seq: null,
    cost_usd: null,
    top_ts: null,
  };
}
