import { expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import { emptyFloorState, type AttemptView } from "../../../protocol/reducer/state.ts";
import { SwarmStartup, swarmDidNotStart, swarmRequestAcknowledged } from "./startup.ts";

const running = (ts: number, value = true) => ({ type: "swarm.state", ts, running: value }) as PoolEvent;
const synthetic = (id: string) => ({ type: "attempt.opened", agent: "synthetic", attempt_id: id }) as PoolEvent;

function snapshot(ts: number, running: boolean, attempts: string[] = []) {
  const floor = emptyFloorState();
  floor.ts = ts;
  floor.swarm = { running, agents: 64, collision_dial: 0, pools: ["swarm"], ever_ran: true };
  for (const id of attempts) floor.attempts[id] = { id, agent: "synthetic" } as AttemptView;
  return floor;
}

it("D7 FR24: the wait expires at 10 seconds, and dial events do not restart it", () => {
  const startup = new SwarmStartup();
  startup.apply(running(100));
  startup.apply(running(5_000));
  expect(swarmDidNotStart(startup.waitingSince, 10_099)).toBe(false);
  expect(swarmDidNotStart(startup.waitingSince, 10_100)).toBe(true);
});
it("D7 FR24: only a synthetic attempt ends the wait; every new run waits again", () => {
  const startup = new SwarmStartup();
  startup.apply(running(100));
  startup.apply({ type: "attempt.opened", agent: "real" } as PoolEvent);
  expect(startup.waitingSince).toBe(100);
  startup.apply(synthetic("first"));
  expect(startup.waitingSince).toBeNull();
  startup.apply(running(200, false));
  startup.apply(running(300));
  expect(startup.waitingSince).toBe(300);
  startup.apply(running(400, false));
  expect(startup.waitingSince).toBeNull();
});

it("D7 FR24: an initial synthetic attempt before swarm.state prevents a false wait", () => {
  const startup = new SwarmStartup();
  startup.apply(synthetic("first"));
  startup.apply(running(100));
  expect(startup.waitingSince).toBeNull();
  expect(swarmDidNotStart(startup.waitingSince, 20_000)).toBe(false);
  startup.apply(running(200, false));
  startup.apply(running(300));
  expect(startup.waitingSince).toBe(300);
});

it("D7 FR24: repeated snapshots preserve the original unresolved 10-second wait", () => {
  const startup = new SwarmStartup();
  startup.apply(running(100));
  startup.snapshot(snapshot(5_000, true));
  startup.snapshot(snapshot(9_000, true));
  expect(startup.waitingSince).toBe(100);
  expect(swarmDidNotStart(startup.waitingSince, 10_100)).toBe(true);
  startup.snapshot(snapshot(11_000, false));
  expect(startup.waitingSince).toBeNull();
  expect(startup.running).toBe(false);
});

it("D7 FR24: snapshots distinguish an old run's attempts from a new arrival", () => {
  const startup = new SwarmStartup();
  startup.snapshot(snapshot(100, true, ["first"]));
  expect(startup.waitingSince).toBeNull();
  startup.snapshot(snapshot(200, false, ["first"]));
  startup.snapshot(snapshot(300, true, ["first"]));
  expect(startup.waitingSince).toBe(300);
  startup.snapshot(snapshot(5_000, true, ["first"]));
  expect(startup.waitingSince).toBe(300);
  startup.snapshot(snapshot(6_000, true, ["first", "second"]));
  expect(startup.waitingSince).toBeNull();
});

it("D7 FR24: joining an empty running snapshot starts one wait that later snapshots retain", () => {
  const startup = new SwarmStartup();
  startup.snapshot(snapshot(100, true));
  startup.snapshot(snapshot(5_000, true));
  expect(startup.waitingSince).toBe(100);
});

it("D18 FL10: a reply waits for running state, including a run completed within one batch", () => {
  const startup = new SwarmStartup();
  startup.apply(running(100, false));
  const requestedRun = startup.run;
  expect(swarmRequestAcknowledged("start", true, requestedRun, startup.run, startup.running)).toBe(false);
  startup.apply(running(200));
  startup.apply(running(201, false));
  expect(swarmRequestAcknowledged("start", false, requestedRun, startup.run, startup.running)).toBe(false);
  expect(swarmRequestAcknowledged("start", true, requestedRun, startup.run, startup.running)).toBe(true);
});

it("D18 FL10: Stop finishes waiting when a stopped run restarts within one batch", () => {
  expect(swarmRequestAcknowledged("stop", true, 1, 1, true)).toBe(false);
  expect(swarmRequestAcknowledged("stop", false, 1, 2, true)).toBe(false);
  expect(swarmRequestAcknowledged("stop", true, 1, 2, true)).toBe(true);
});
