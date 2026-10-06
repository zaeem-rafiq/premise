// The launch schedule of one Swarm run (01-core SWR1, 02-tidepool 10.4), one tick at a time:
// regular agents at `launch_per_second` up to `agents`, one `rescale-energy` every
// `rescale_every_s` while the dial is above 0, and the run's own end ATTEMPT_TIMEOUT_MS after
// its last regular agent was due (SWR1, added 2026-10-05). Expected values are worked from those
// rules, not from the function (BP1).

import { describe, expect, it } from "vitest";
import { ATTEMPT_TIMEOUT_MS } from "../protocol/constants.ts";
import { runTick } from "./run-schedule.ts";

const START = 1_000_000;
const RUN = { startMs: START, agents: 100, launchPerSecond: 50, collisionDial: 0.25, rescaleEverySecs: 15 };

describe("runTick: what one tick of a run launches, and when the run ends", () => {
  it("regular agents are due at launch_per_second, never more than `agents`", () => {
    // 50 a second: 1.5 s in, 75 are due; 3 s in, 150 would be due but the run has 100.
    expect(runTick({ ...RUN, now: START + 1_500, doneAt: null }).regularDue).toBe(75);
    expect(runTick({ ...RUN, now: START + 3_000, doneAt: null }).regularDue).toBe(100);
  });

  it("one rescale-energy every rescale_every_s while the dial is above 0, none at dial 0", () => {
    // 31 s in at 15 s: two are due (at 15 s and 30 s).
    expect(runTick({ ...RUN, now: START + 31_000, doneAt: null }).rescaleDue).toBe(2);
    expect(runTick({ ...RUN, collisionDial: 0, now: START + 31_000, doneAt: null }).rescaleDue).toBe(0);
    expect(runTick({ ...RUN, rescaleEverySecs: 0, now: START + 31_000, doneAt: null }).rescaleDue).toBe(0);
  });

  it("the run ends ATTEMPT_TIMEOUT_MS after its last regular agent was due, and not before", () => {
    // All 100 are due 2 s in: that tick records doneAt = START + 2_000.
    const due = runTick({ ...RUN, now: START + 2_000, doneAt: null });
    expect(due.doneAt).toBe(START + 2_000);
    expect(due.ended).toBe(false);
    const almost = runTick({ ...RUN, now: START + 2_000 + ATTEMPT_TIMEOUT_MS - 1, doneAt: due.doneAt });
    expect(almost.ended).toBe(false);
    expect(almost.doneAt).toBe(START + 2_000);
    expect(runTick({ ...RUN, now: START + 2_000 + ATTEMPT_TIMEOUT_MS, doneAt: due.doneAt }).ended).toBe(true);
  });

  it("while regular agents are still due the run has no end time", () => {
    expect(runTick({ ...RUN, now: START + 1_000, doneAt: null })).toMatchObject({ doneAt: null, ended: false });
  });

  it("a raised agent count reopens the run: the end time is cleared until the new quota is due", () => {
    // 100 were done at 2 s; the owner raises the run to 400, due at 8 s.
    const raised = runTick({ ...RUN, agents: 400, now: START + 5_000, doneAt: START + 2_000 });
    expect(raised).toMatchObject({ regularDue: 250, doneAt: null, ended: false });
  });

  it("a run of 0 agents launches only rescales and ends ATTEMPT_TIMEOUT_MS after it started", () => {
    const first = runTick({ ...RUN, agents: 0, now: START, doneAt: null });
    expect(first).toMatchObject({ regularDue: 0, doneAt: START, ended: false });
    expect(runTick({ ...RUN, agents: 0, now: START + ATTEMPT_TIMEOUT_MS, doneAt: START }).ended).toBe(true);
  });
});
