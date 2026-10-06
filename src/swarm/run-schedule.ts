// The launch schedule of one Swarm run (01-core SWR1, 02-tidepool 10.4), as one decision per
// tick of the launcher: how many regular agents are due by `now` (at `launch_per_second`, at
// most `agents`), how many `rescale-energy` agents (one every `rescale_every_s` while the dial is
// above 0), and whether the run has ended. A run ends by itself ATTEMPT_TIMEOUT_MS after its last
// regular agent was due: every agent it launched has ended by then, so a later meaning change has
// nobody in flight to reach (SWR1, added 2026-10-05; a Workflow instance has a step limit, and a
// run nobody stopped would otherwise tick until it failed with `running` still on every stream).
//
// Pure (SY1/SY2): the clock is the `now` argument.

import { ATTEMPT_TIMEOUT_MS } from "../protocol/constants.ts";

export type RunTickInput = {
  now: number;
  startMs: number;
  agents: number;
  launchPerSecond: number;
  collisionDial: number;
  rescaleEverySecs: number;
  /** When the last regular agent became due; null while some are still to come. */
  doneAt: number | null;
};

export type RunTick = { regularDue: number; rescaleDue: number; doneAt: number | null; ended: boolean };

export function runTick(input: RunTickInput): RunTick {
  const elapsed = input.now - input.startMs;
  const regularDue = Math.min(input.agents, Math.floor((input.launchPerSecond * elapsed) / 1000));
  const rescaleDue =
    input.collisionDial > 0 && input.rescaleEverySecs > 0 ? Math.floor(elapsed / (input.rescaleEverySecs * 1000)) : 0;
  const doneAt = regularDue >= input.agents ? (input.doneAt ?? input.now) : null;
  const ended = doneAt !== null && input.now - doneAt >= ATTEMPT_TIMEOUT_MS;
  return { regularDue, rescaleDue, doneAt, ended };
}
