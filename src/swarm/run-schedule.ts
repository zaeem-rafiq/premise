// The launch schedule of one Swarm run (01-core SWR1, 02-tidepool 10.4, both amended
// 2026-10-05), as one decision per tick of the launcher: how many regular agents are due by
// `now` (at `launch_per_second`, at most `agents`), how many `rescale-energy` agents (one every
// `rescale_every_s` while the dial is above 0, for as long as the regular agents are still being
// launched), and whether the run has ended: it ends at the tick its last agent is due, after that
// tick's launches. `running` means launching; the agents in flight finish on their own.
//
// Pure (SY1/SY2): the clock is the `now` argument.

export type RunTickInput = {
  now: number;
  startMs: number;
  agents: number;
  launchPerSecond: number;
  collisionDial: number;
  rescaleEverySecs: number;
};

export type RunTick = { regularDue: number; rescaleDue: number; ended: boolean };

export function runTick(input: RunTickInput): RunTick {
  const elapsed = Math.max(0, input.now - input.startMs);
  const regularDue =
    input.launchPerSecond > 0 ? Math.min(input.agents, Math.floor((input.launchPerSecond * elapsed) / 1000)) : 0;
  // The moment the last regular agent is due: rescales stop there (10.4).
  const launchEndMs = input.launchPerSecond > 0 ? (input.agents * 1000) / input.launchPerSecond : 0;
  const rescaleWindow = Math.min(elapsed, launchEndMs);
  const rescaleDue =
    input.collisionDial > 0 && input.rescaleEverySecs > 0
      ? Math.floor(rescaleWindow / (input.rescaleEverySecs * 1000))
      : 0;
  return { regularDue, rescaleDue, ended: regularDue >= input.agents };
}
