import type { PoolEvent } from "../../../protocol/events.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";

/** FR24: each running transition starts a fresh wait, even when older attempts remain. */
export class SwarmStartup {
  running = false;
  run = 0;
  waitingSince: number | null = null;
  private sawSwarmState = false;
  private syntheticAttempts = new Set<string>();

  snapshot(floor: FloorState): void {
    const running = floor.swarm?.running === true;
    const synthetic = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");
    if (running && !this.running) this.run += 1;
    const newSynthetic = synthetic.some((a) => !this.syntheticAttempts.has(a.id));
    if (!running || newSynthetic) this.waitingSince = null;
    else if (!this.running) {
      this.waitingSince = !this.sawSwarmState && synthetic.length > 0 ? null : floor.ts;
    }
    // A repeated snapshot must not restart an unresolved timer or mistake attempts from
    // an earlier run for the first attempt of this one.
    for (const attempt of synthetic) this.syntheticAttempts.add(attempt.id);
    this.running = running;
    if (floor.swarm !== null) this.sawSwarmState = true;
  }

  apply(event: PoolEvent): void {
    if (event.type === "swarm.state") {
      if (event.running && !this.running) {
        this.run += 1;
        this.waitingSince = !this.sawSwarmState && this.syntheticAttempts.size > 0 ? null : event.ts;
      }
      if (!event.running) this.waitingSince = null;
      this.running = event.running;
      this.sawSwarmState = true;
    }
    if (event.type === "attempt.opened" && event.agent === "synthetic") {
      this.syntheticAttempts.add(event.attempt_id);
      this.waitingSince = null;
    }
  }
}

export function swarmDidNotStart(waitingSince: number | null, clock: number): boolean {
  return waitingSince !== null && clock - waitingSince >= 10_000;
}

/** D18: start and stop transitions may both arrive in one batch before the request reply. */
export function swarmRequestAcknowledged(
  pending: "start" | "stop" | null,
  answered: boolean,
  requestedRun: number,
  run: number,
  running: boolean | undefined,
): boolean {
  if (!answered || pending === null) return false;
  return run > requestedRun || (pending === "start" ? running === true : running === false);
}
