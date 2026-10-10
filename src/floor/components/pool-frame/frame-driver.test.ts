// The pool frame's behavior against the spec's message and fallback rules: CO20-CO23, AC3/FL3,
// FR20, FR28, AS14, RY17/AC23. A fake sink records what would go to the iframe and hands the
// driver its timers by name — expected values are the spec's constants and addresses.

import { describe, expect, it } from "vitest";
import type { FloorToPool } from "../../../protocol/channel.ts";
import {
  FRAME_ADVANCE_DEBOUNCE_MS,
  FRAME_ADVANCE_TIMEOUT_MS,
  FRAME_LOAD_TIMEOUT_MS,
  FRAME_PROBE_RETRY_MS,
  HOST_SEED,
  OFFLINE_AFTER_MS,
  POOL_STALL_MS,
} from "../../../protocol/constants.ts";
import { FrameDriver } from "./frame-driver.ts";
import type { DriverOptions, DriverTarget, FrameStats, TimerKey } from "./frame-driver.ts";

const POOL = "tidepool";
const C1 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"; // tracer landing.landed seq 1
const C2 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0d1"; // tracer landing.landed seq 2

function stats(version: string, over: Partial<FrameStats> = {}): FrameStats {
  return {
    type: "stats",
    source: "main",
    version,
    seq: null,
    tick: 1,
    paused: false,
    kinds: {},
    shown: 0,
    total: 0,
    swap: null,
    selftest: null,
    ...over,
  };
}

class Harness {
  loads: string[] = [];
  posts: FloorToPool[] = [];
  timers = new Map<TimerKey, number>();
  driver: FrameDriver;

  constructor(opts: DriverOptions) {
    this.driver = new FrameDriver(
      {
        load: (src) => this.loads.push(src),
        post: (message) => this.posts.push(message),
        schedule: (key, ms) => this.timers.set(key, ms),
        cancel: (key) => this.timers.delete(key),
        changed: () => undefined,
      },
      opts,
    );
  }

  target(target: Partial<DriverTarget>): void {
    this.driver.setTarget({ landedCommit: null, greenCommit: null, greenSeq: null, ...target });
  }

  /** Fire the timer the driver armed under `key`, as the wall clock would. */
  fire(key: TimerKey): void {
    expect(this.timers.get(key), `timer ${key} was not armed`).not.toBeUndefined();
    this.timers.delete(key);
    this.driver.onTimer(key);
  }

  armed(key: TimerKey): number | undefined {
    return this.timers.get(key);
  }

  ofType<T extends FloorToPool["type"]>(type: T): Extract<FloorToPool, { type: T }>[] {
    return this.posts.filter((m) => m.type === type) as Extract<FloorToPool, { type: T }>[];
  }
}

describe("the live frame address and landing flow (CO20, CO21, SE16a)", () => {
  it("loads /pool/{pool}/main/?seed=<HOST_SEED> once the pool state arrives", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    expect(h.loads).toEqual([`/pool/tidepool/main/?seed=${HOST_SEED}`]);
  });

  it("a landing.landed arms a debounced probe — never a reload (CO21)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.target({ landedCommit: C2 });
    expect(h.armed("probe")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
    h.fire("probe");
    expect(h.ofType("probe")).toHaveLength(1);
    expect(h.loads).toHaveLength(1); // still the same live source
  });

  it("AC3/FL3: landing.accepted alone moves nothing — no load, no probe", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.fire("probe"); // the first commit's own probe; drains the queue
    const postsBefore = h.posts.length;
    // `landing.accepted` changes head_commit/landings but never landed_commit: the same target.
    h.target({ landedCommit: C1 });
    h.target({ landedCommit: C1 });
    expect(h.loads).toHaveLength(1);
    expect(h.armed("probe")).toBeUndefined();
    expect(h.posts).toHaveLength(postsBefore);
  });

  it("a stats naming an older version gets exactly one more probe (CO21)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onLoad();
    h.target({ landedCommit: C2 });
    h.fire("probe");
    h.driver.onStats(stats("c-stale"));
    expect(h.armed("probe-retry")).toBe(FRAME_PROBE_RETRY_MS);
    h.fire("probe-retry");
    h.driver.onStats(stats("c-stale"));
    expect(h.armed("probe-retry")).toBeUndefined(); // once, not a loop
    expect(h.ofType("probe")).toHaveLength(2);
  });

  it("a stats naming the expected version clears the expectation", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onLoad();
    h.target({ landedCommit: C2 });
    h.fire("probe");
    h.driver.onStats(stats(`c-${C2}`));
    expect(h.driver.expecting).toBeNull();
    expect(h.armed("probe-retry")).toBeUndefined();
  });
});

describe("the kind hold before the first pool.state (IR12)", () => {
  it("holds the first live load while the kind is undecided, then loads when pool.state lands", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ poolKnown: false });
    expect(h.loads).toHaveLength(0);
    expect(h.armed("kind")).toBe(OFFLINE_AFTER_MS);
    h.target({ poolKnown: true, landedCommit: C1 });
    expect(h.loads).toEqual([`/pool/tidepool/main/?seed=${HOST_SEED}`]);
    expect(h.armed("kind")).toBeUndefined();
  });

  it("the wait lapses at the lost-connection window: a dead stream still gets its frame", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ poolKnown: false });
    h.fire("kind");
    expect(h.loads).toEqual([`/pool/tidepool/main/?seed=${HOST_SEED}`]);
    // and once it loaded, the hold is over — a still-undecided target cannot un-load it
    h.target({ poolKnown: false });
    expect(h.armed("kind")).toBeUndefined();
    expect(h.loads).toHaveLength(1);
  });

  it("a released load keeps the first-load probe expectation of the commit it carried (CO21)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ poolKnown: false });
    h.target({ poolKnown: false });
    h.target({ poolKnown: true, landedCommit: C1 });
    expect(h.armed("probe")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
  });

  it("a pause taken during the wait lands on the first load's address (AC11)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.driver.setUserPaused(true);
    h.target({ poolKnown: false });
    h.target({ poolKnown: true });
    expect(h.loads).toEqual([`/pool/tidepool/main/?seed=${HOST_SEED}&paused=1`]);
  });

  it("a replay frame does not wait on the kind — the position's commit governs (RY17)", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1, poolKnown: false });
    expect(h.loads).toEqual([`/pool/tidepool/${C1}/?seed=${HOST_SEED}`]);
    expect(h.armed("kind")).toBeUndefined();
  });
});

describe("the replay frame's advance flow (8.6, RY17, AC23)", () => {
  it("loads straight at the position's commit, not the moving source", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1 });
    expect(h.loads).toEqual([`/pool/tidepool/${C1}/?seed=${HOST_SEED}`]);
  });

  it("a new position posts advance {version} — never probe (AC23)", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1 });
    h.driver.onLoad();
    h.target({ landedCommit: C2 });
    expect(h.armed("advance")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
    h.fire("advance");
    expect(h.ofType("advance")).toEqual([{ type: "advance", version: `c-${C2}` }]);
    expect(h.ofType("probe")).toHaveLength(0);
    // A stray probe timer in replay mode still posts nothing (the guard is on the way out).
    h.driver.onTimer("probe");
    expect(h.ofType("probe")).toHaveLength(0);
  });

  it("an unanswered advance reloads the frame at the commit address (RY17)", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1 });
    h.driver.onLoad();
    h.target({ landedCommit: C2 });
    h.fire("advance");
    expect(h.armed("advance-wait")).toBe(FRAME_ADVANCE_TIMEOUT_MS);
    h.fire("advance-wait");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/${C2}/?seed=${HOST_SEED}`);
  });

  it("a stats with the version cancels the reload", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1 });
    h.driver.onLoad();
    h.target({ landedCommit: C2 });
    h.fire("advance");
    h.driver.onStats(stats(`c-${C2}`));
    h.driver.onTimer("advance-wait");
    expect(h.loads).toHaveLength(1);
  });

  it("before the stream starts there is no commit — the frame waits", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: null });
    expect(h.loads).toHaveLength(0);
  });
});

describe("load failure and stalls (FR20, FR28)", () => {
  it("a frame that does not load in FRAME_LOAD_TIMEOUT_MS is in the error phase", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    expect(h.armed("load")).toBe(FRAME_LOAD_TIMEOUT_MS);
    h.fire("load");
    expect(h.driver.phase).toBe("error");
  });

  it("a first stall with a green commit reloads on source green (FR28, AC29)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1, greenCommit: "g1", greenSeq: 3 });
    h.driver.onStats(stats(`c-${C1}`));
    expect(h.armed("stall")).toBe(POOL_STALL_MS);
    h.fire("stall");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/green/?seed=${HOST_SEED}`);
    expect(h.driver.stalledCaption).toEqual({
      id: "frame.stalled.green",
      vars: { landing: "landing 3" },
    });
  });

  it("a first stall without green reloads main once; a second shows frame.stalled (AC29)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/main/?seed=${HOST_SEED}`);
    expect(h.driver.stalledCaption?.id).toBe("frame.stalled.reloaded");
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    expect(h.driver.phase).toBe("stalled");
    expect(h.driver.stalledCaption?.id).toBe("frame.stalled");
    expect(h.loads).toHaveLength(2);
  });

  it("a frame on green gets probe when green.advanced arrives (FR28)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1, greenCommit: "g1", greenSeq: 3 });
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    h.driver.onStats(stats("c-g1"));
    h.target({ landedCommit: C1, greenCommit: "g2", greenSeq: 4 });
    expect(h.armed("probe")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
    h.fire("probe");
    expect(h.ofType("probe")).toHaveLength(1);
  });

  it("a replay frame reloads once at its own address, then shows frame.stalled", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/${C1}/?seed=${HOST_SEED}`);
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    expect(h.driver.phase).toBe("stalled");
    expect(h.loads).toHaveLength(2);
  });

  it("frame.reload goes back to main and clears the stall bookkeeping", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1, greenCommit: "g1", greenSeq: 3 });
    h.driver.onStats(stats(`c-${C1}`));
    h.fire("stall");
    h.driver.reload();
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/main/?seed=${HOST_SEED}`);
    expect(h.driver.stalledCaption).toBeNull();
  });
});

describe("pause, visibility and highlight (CO23a, AS14, CO23b)", () => {
  it("posts pause then resume, once each", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.driver.setUserPaused(true);
    h.driver.setUserPaused(true); // no second post
    h.driver.setUserPaused(false);
    expect(h.posts).toEqual([{ type: "pause" }, { type: "resume" }]);
  });

  it("pauses a frame that is not visible and resumes it when it returns (AS14)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.driver.setVisible(false);
    h.driver.setVisible(true);
    expect(h.posts).toEqual([{ type: "pause" }, { type: "resume" }]);
  });

  it("a frame loading while paused carries the paused page parameter (6.4/AC11)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.driver.setUserPaused(true);
    h.target({ landedCommit: C1 });
    expect(h.loads).toEqual([`/pool/tidepool/main/?seed=${HOST_SEED}&paused=1`]);
  });

  it("a paused frame is never counted stalled (FR28: visible and not paused)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.driver.setUserPaused(true);
    expect(h.armed("stall")).toBeUndefined();
  });

  it("posts highlight on set and again on the first stats of a new page (CO23b)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats(`c-${C1}`));
    h.driver.setHighlight(["ring-a"]);
    h.driver.reload();
    h.driver.onStats(stats(`c-${C1}`));
    expect(h.ofType("highlight")).toEqual([
      { type: "highlight", kinds: ["ring-a"] },
      { type: "highlight", kinds: ["ring-a"] },
    ]);
  });
});

describe("the self-test badge's probe (CO25a, NP8)", () => {
  it("with selftest on, each newly reported version gets one probe+selftest until its result arrives", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.setSelftest(true);
    h.driver.onStats(stats("c-" + C1));
    expect(h.ofType("probe")).toEqual([{ type: "probe", selftest: true }]);
    // The same version does not ask twice…
    h.driver.onStats(stats("c-" + C1));
    expect(h.ofType("probe")).toHaveLength(1);
    // …until its own selftest result lands.
    h.driver.onStats(stats("c-" + C1, { selftest: { version: "c-" + C1, ok: true, failed: [] } }));
    const v2 = "c-" + C2;
    h.driver.onStats(stats(v2));
    expect(h.ofType("probe")).toEqual([
      { type: "probe", selftest: true },
      { type: "probe", selftest: true },
    ]);
    h.driver.onStats(stats(v2, { selftest: { version: v2, ok: true, failed: [] } }));
    h.driver.onStats(stats(v2));
    expect(h.ofType("probe")).toHaveLength(2);
  });

  it("with selftest off the driver never posts probe+selftest, and lastStats follows the newest stats", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: C1 });
    h.driver.onStats(stats("c-" + C1));
    expect(h.ofType("probe").filter((m) => m.selftest === true)).toHaveLength(0);
    expect(h.driver.lastStats?.version).toBe("c-" + C1);
  });
});

describe("pause on a load in flight (AC11, 6.4)", () => {
  it("pausing while the page still loads keeps that load and posts the pause at its first stats", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: null });
    expect(h.loads).toEqual([`/pool/${POOL}/main/?seed=${HOST_SEED}`]);
    h.driver.setUserPaused(true);
    expect(h.loads).toEqual([`/pool/${POOL}/main/?seed=${HOST_SEED}`]); // no second load
    expect(h.ofType("pause")).toHaveLength(0); // nobody to tell yet
    h.driver.onStats(stats("c-seed"));
    expect(h.ofType("pause")).toHaveLength(1);
  });

  it("a stall watch is never armed while paused, but arms again on resume", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ landedCommit: null });
    h.driver.setUserPaused(true);
    h.driver.onStats(stats("c-seed"));
    expect(h.armed("stall")).toBeUndefined();
    h.driver.setUserPaused(false);
    expect(h.ofType("resume")).toHaveLength(1);
    expect(h.armed("stall")).toBe(POOL_STALL_MS);
  });
});
