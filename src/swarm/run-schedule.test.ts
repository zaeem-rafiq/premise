// The launch schedule of one Swarm run (01-core SWR1, 02-tidepool 10.4, both amended
// 2026-10-05), one tick at a time: regular agents at `launch_per_second` up to `agents`; while the
// dial is above 0, one `rescale-energy` every `rescale_every_s` for as long as the run is still
// launching its agents; and the run ends once its last agent is launched. Expected values are
// worked from those rules, not from the function (BP1).

import { describe, expect, it } from "vitest";
import { runTick } from "./run-schedule.ts";

const START = 1_000_000;
// 100 agents at 4 a second: the last one is due 25 s in.
const RUN = { startMs: START, agents: 100, launchPerSecond: 4, collisionDial: 0.25, rescaleEverySecs: 10 };

describe("runTick: what one tick of a run launches, and when the run ends", () => {
  it("regular agents are due at launch_per_second, never more than `agents`", () => {
    expect(runTick({ ...RUN, now: START + 2_500 }).regularDue).toBe(10); // 4 a second, 2.5 s
    expect(runTick({ ...RUN, now: START + 40_000 }).regularDue).toBe(100);
  });

  it("rescales come every rescale_every_s while the agents are still being launched", () => {
    // 21 s in, at 10 s: two are due (10 s, 20 s); the launch still runs until 25 s.
    expect(runTick({ ...RUN, now: START + 21_000 }).rescaleDue).toBe(2);
  });

  it("no rescale is due after the last agent was due, however long the run lasts", () => {
    // The last regular agent is due at 25 s: the rescales of 10 s and 20 s, and no more.
    expect(runTick({ ...RUN, now: START + 25_000 }).rescaleDue).toBe(2);
    expect(runTick({ ...RUN, now: START + 600_000 }).rescaleDue).toBe(2);
  });

  it("no rescale at dial 0 or when rescale_every_s is 0", () => {
    expect(runTick({ ...RUN, collisionDial: 0, now: START + 21_000 }).rescaleDue).toBe(0);
    expect(runTick({ ...RUN, rescaleEverySecs: 0, now: START + 21_000 }).rescaleDue).toBe(0);
  });

  it("the run ends at the tick its last agent is due, and not before", () => {
    expect(runTick({ ...RUN, now: START + 24_999 }).ended).toBe(false);
    expect(runTick({ ...RUN, now: START + 25_000 }).ended).toBe(true);
  });

  it("a run of 0 agents launches nothing and ends at once", () => {
    expect(runTick({ ...RUN, agents: 0, now: START })).toEqual({ regularDue: 0, rescaleDue: 0, ended: true });
  });
});
