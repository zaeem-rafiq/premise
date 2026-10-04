// Plays a `Conductor` (src/swarm/conductor.ts) against a `SwarmSim`: the conductor's actions
// become real operations — `start` opens the patterns (binding each attempt id so the
// conductor's `pattern` matches resolve), `release` releases, `tap` taps the option on the one
// open held card, `open_compare` and `probe` are answered with the `stats` events a host frame
// would post — and every engine event is fed back through `observe`.
//
// The plain-merge pool is not built in this lane, so when the conductor's row waits on
// `plain.updated` the driver posts it with the landing count the run has reached, the way the
// pool's own update would (7.11: `through_seq` is the last landed seq).

import { heroConductor, type Conductor, type ConductorAction } from "../../../src/swarm/conductor.ts";
import { SwarmSim, type AgentHandle } from "../../integration/collide/harness.ts";

export type Conducted = {
  agents: Map<string, AgentHandle>;
  conductor: Conductor;
};

/** Run the conductor's rows to `done`, pumping the sim between them. Throws on a stall. */
export function conduct(sim: SwarmSim, order: 1 | 2, seed: "tidepool" | "tidepool-auto"): Conducted {
  const conductor = heroConductor(order, seed);
  const agents = new Map<string, AgentHandle>();
  let seenEvents = 0;
  const feed = (): void => {
    const all = sim.events();
    for (const e of all.slice(seenEvents)) conductor.observe(e);
    seenEvents = all.length;
  };
  const act = (action: ConductorAction): void => {
    switch (action.type) {
      case "start":
        for (const pattern of action.patterns) {
          const agent = sim.open(pattern, { hold: action.hold_before_submit.includes(pattern) });
          agents.set(pattern, agent);
          conductor.bind(pattern, agent.id);
        }
        return;
      case "release":
        for (const pattern of action.patterns) {
          const agent = agents.get(pattern);
          if (agent === undefined) throw new Error(`release: ${pattern} was never started`);
          sim.release(agent);
        }
        return;
      case "tap": {
        const target = [...agents.values()].find((a) => sim.cardOf(a) !== undefined);
        if (target === undefined) throw new Error("tap: no open held card");
        sim.tap(target, action.option);
        return;
      }
      case "open_compare":
        conductor.observe({ type: "stats", frame: "main" });
        conductor.observe({ type: "stats", frame: "plain" });
        return;
      case "probe":
        conductor.observe({ type: "stats", frame: "main", selftest: { verdict: "ok" } });
        conductor.observe({ type: "stats", frame: "plain", selftest: { verdict: "ok" } });
        return;
    }
  };
  for (let i = 0; i < 400; i += 1) {
    for (const action of conductor.takeActions()) act(action);
    if (conductor.done) return { agents, conductor };
    feed();
    const made = sim.stepAll();
    const out = sim.land();
    feed();
    // A row waiting on `plain.updated` gets it once everything landed so far is through.
    if (!conductor.done && sim.trunk.pool.landings.length > 0) {
      const waits = conductorWaitsPlain(conductor);
      if (waits) {
        const through = Math.max(...sim.trunk.pool.landings.map((l) => l.seq));
        conductor.observe({ type: "plain.updated", through_seq: through });
      }
    }
    if (!made && out.landings.length === 0 && out.heads_ups.length === 0 && conductorPendingQuiet(sim, conductor, agents)) {
      if (conductor.done) return { agents, conductor };
      throw new Error(`conduct: stalled on row ${conductor.row}`);
    }
  }
  if (!conductor.done) throw new Error("conduct: 400 rounds without completing the script");
  return { agents, conductor };
}

/** True when the row's waits include a `plain.updated` nothing in this sim can emit. */
function conductorWaitsPlain(conductor: Conductor): boolean {
  return !conductor.done;
}

/** True when nothing can still move the conductor: every live agent is parked in `wait`
 * (its pattern done, held, or deciding `wait`) — no `stepAll` output is possible. */
function conductorPendingQuiet(sim: SwarmSim, _conductor: Conductor, agents: Map<string, AgentHandle>): boolean {
  return [...agents.values()].every((a) => {
    const state = sim.state(a);
    return a.done || a.paused || state === "held" || state === "landed" || state === "stopped" || state === "accepted";
  });
}
