// The plain-merge pool frame's behavior against the spec's message and fallback rules: SE16a
// and AC23 (live: probe on `plain.updated`, never `advance`, the address never moves; Replay:
// `advance` to `p-<commit>`, never `probe`), FR20, FR28's other-frame stall rule, CO23a pause,
// CO25a self-test. The fake sink records what would go to the iframe; expected values are the
// spec's constants and addresses (BP1).

import { describe, expect, it } from "vitest";
import type { FloorToPool } from "../../../protocol/channel.ts";
import {
  FRAME_ADVANCE_DEBOUNCE_MS,
  FRAME_ADVANCE_TIMEOUT_MS,
  FRAME_LOAD_TIMEOUT_MS,
  FRAME_PROBE_RETRY_MS,
  HOST_SEED,
  POOL_STALL_MS,
} from "../../../protocol/constants.ts";
import { PlainFrameDriver } from "./plain-driver.ts";
import type { DriverSink, FrameStats, PlainDriverOptions, PlainDriverTarget, TimerKey } from "./plain-driver.ts";

const POOL = "tidepool";
const P1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"; // plain.updated commit 1
const P2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"; // plain.updated commit 2

function stats(version: string, over: Partial<FrameStats> = {}): FrameStats {
  return {
    type: "stats",
    source: "plain",
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
  driver: PlainFrameDriver;

  constructor(opts: PlainDriverOptions) {
    const sink: DriverSink = {
      load: (src) => this.loads.push(src),
      post: (message) => this.posts.push(message),
      schedule: (key, ms) => this.timers.set(key, ms),
      cancel: (key) => this.timers.delete(key),
      changed: () => undefined,
    };
    this.driver = new PlainFrameDriver(sink, opts);
  }

  target(target: Partial<PlainDriverTarget>): void {
    this.driver.setTarget({ plainCommit: null, ...target });
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

describe("the plain live frame address and plain.updated flow (3.6, SE16a, AC23)", () => {
  it("loads /pool/{pool}/plain/?seed=<HOST_SEED> on the first target — the moving source", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: null });
    expect(h.loads).toEqual([`/pool/tidepool/plain/?seed=${HOST_SEED}`]);
  });

  it("a plain.updated arms a debounced probe — the src never moves (AC23)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.fire("probe"); // the first commit's own probe
    h.driver.onStats(stats(`p-${P1}`));
    h.target({ plainCommit: P2 });
    expect(h.armed("probe")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
    h.fire("probe");
    expect(h.ofType("probe")).toHaveLength(2);
    expect(h.loads).toHaveLength(1); // still the same live source, never an address by commit
    expect(h.ofType("advance")).toHaveLength(0);
  });

  it("a stats naming an older p- version gets exactly one more probe (CO21 applied to plain)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.fire("probe");
    h.driver.onStats(stats("p-stale"));
    expect(h.armed("probe-retry")).toBe(FRAME_PROBE_RETRY_MS);
    h.fire("probe-retry");
    h.driver.onStats(stats("p-stale"));
    expect(h.armed("probe-retry")).toBeUndefined(); // once, not a loop
    expect(h.ofType("probe")).toHaveLength(2);
  });

  it("a stats naming the expected p- version clears the expectation", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.fire("probe");
    h.driver.onStats(stats(`p-${P1}`));
    expect(h.driver.expecting).toBeNull();
    expect(h.armed("probe-retry")).toBeUndefined();
  });

  it("a frame that errored while plain was null gets a fresh load when a version arrives", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: null });
    h.fire("load");
    expect(h.driver.phase).toBe("error");
    h.target({ plainCommit: P1 });
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/plain/?seed=${HOST_SEED}`);
    expect(h.loads).toHaveLength(2);
  });
});

describe("the plain commit frame in Replay (8.6, RY17, AC23)", () => {
  it("loads straight at the p-<commit> address of the newest plain.updated", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: P1 });
    expect(h.loads).toEqual([`/pool/tidepool/p-${P1}/?seed=${HOST_SEED}`]);
  });

  it("before the first plain.updated there is no commit — the frame waits", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: null });
    expect(h.loads).toHaveLength(0);
  });

  it("a new plain.updated position posts advance {p-version} — never probe (AC23)", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: P1 });
    h.driver.onLoad();
    h.target({ plainCommit: P2 });
    expect(h.armed("advance")).toBe(FRAME_ADVANCE_DEBOUNCE_MS);
    h.fire("advance");
    expect(h.ofType("advance")).toEqual([{ type: "advance", version: `p-${P2}` }]);
    expect(h.ofType("probe")).toHaveLength(0);
    // A stray probe timer in replay mode still posts nothing (the guard is on the way out).
    h.driver.onTimer("probe");
    expect(h.ofType("probe")).toHaveLength(0);
  });

  it("an unanswered advance reloads the frame at the p- commit address (RY17)", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: P1 });
    h.driver.onLoad();
    h.target({ plainCommit: P2 });
    h.fire("advance");
    expect(h.armed("advance-wait")).toBe(FRAME_ADVANCE_TIMEOUT_MS);
    h.fire("advance-wait");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/p-${P2}/?seed=${HOST_SEED}`);
  });

  it("a stats with the p- version cancels the reload", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: P1 });
    h.driver.onLoad();
    h.target({ plainCommit: P2 });
    h.fire("advance");
    h.driver.onStats(stats(`p-${P2}`));
    h.driver.onTimer("advance-wait");
    expect(h.loads).toHaveLength(1);
  });
});

describe("load failure and stalls (FR20, FR28's other-frames rule)", () => {
  it("a frame that does not load in FRAME_LOAD_TIMEOUT_MS is in the error phase", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: null });
    expect(h.armed("load")).toBe(FRAME_LOAD_TIMEOUT_MS);
    h.fire("load");
    expect(h.driver.phase).toBe("error");
  });

  it("a first stall reloads once at its own plain address; a second shows frame.stalled", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.driver.onStats(stats(`p-${P1}`));
    expect(h.armed("stall")).toBe(POOL_STALL_MS);
    h.fire("stall");
    // kind "other": reload at its own address — the plain source, never green (FR28).
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/plain/?seed=${HOST_SEED}`);
    h.driver.onStats(stats(`p-${P1}`));
    h.fire("stall");
    expect(h.driver.phase).toBe("stalled");
    expect(h.driver.stalledCaption?.id).toBe("frame.stalled");
    expect(h.loads).toHaveLength(2);
  });

  it("a replay frame reloads once at its own p- address, then shows frame.stalled", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.target({ plainCommit: P1 });
    h.driver.onStats(stats(`p-${P1}`));
    h.fire("stall");
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/p-${P1}/?seed=${HOST_SEED}`);
    h.driver.onStats(stats(`p-${P1}`));
    h.fire("stall");
    expect(h.driver.phase).toBe("stalled");
    expect(h.loads).toHaveLength(2);
  });

  it("frame.reload goes back to the plain source and clears the stall bookkeeping", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.driver.onStats(stats(`p-${P1}`));
    h.fire("stall");
    h.driver.reload();
    expect(h.loads.at(-1)).toBe(`/pool/tidepool/plain/?seed=${HOST_SEED}`);
    expect(h.driver.stalledCaption).toBeNull();
  });

  it("frame.reload in Replay with no plain.updated yet stays in loading", () => {
    const h = new Harness({ pool: POOL, mode: "replay" });
    h.driver.reload();
    expect(h.loads).toHaveLength(0);
    expect(h.driver.phase).toBe("loading");
  });
});

describe("pause, visibility and the self-test badge (CO23a, AS14, CO25a)", () => {
  it("posts pause then resume, once each", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.driver.onStats(stats(`p-${P1}`));
    h.driver.setUserPaused(true);
    h.driver.setUserPaused(true); // no second post
    h.driver.setUserPaused(false);
    expect(h.posts).toEqual([{ type: "pause" }, { type: "resume" }]);
  });

  it("pauses a frame that is not visible and resumes it when it returns (AS14)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.driver.onStats(stats(`p-${P1}`));
    h.driver.setVisible(false);
    h.driver.setVisible(true);
    expect(h.posts).toEqual([{ type: "pause" }, { type: "resume" }]);
  });

  it("a frame loading while paused carries the paused page parameter (6.4/AC11)", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.driver.setUserPaused(true);
    h.target({ plainCommit: P1 });
    expect(h.loads).toEqual([`/pool/tidepool/plain/?seed=${HOST_SEED}&paused=1`]);
  });

  it("with selftest on, each reported version gets one probe+selftest until its result arrives", () => {
    const h = new Harness({ pool: POOL, mode: "live" });
    h.target({ plainCommit: P1 });
    h.driver.setSelftest(true);
    h.driver.onStats(stats(`p-${P1}`));
    expect(h.ofType("probe")).toEqual([{ type: "probe", selftest: true }]);
    h.driver.onStats(stats(`p-${P1}`)); // the same version does not ask twice
    expect(h.ofType("probe")).toHaveLength(1);
    h.driver.onStats(stats(`p-${P1}`, { selftest: { version: `p-${P1}`, ok: true, failed: [] } }));
    const v2 = `p-${P2}`;
    h.driver.onStats(stats(v2));
    expect(h.ofType("probe")).toEqual([
      { type: "probe", selftest: true },
      { type: "probe", selftest: true },
    ]);
  });
});
