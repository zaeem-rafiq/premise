// test/cases/coverage.test.ts — the event-coverage table of 01-core.md 12.1 and EV2a.
//
// Every event type the protocol names is listed once, with the source EV2a assigns it. The test
// plays every vector of premise-cases.json and the collision scenarios through the real engine
// and collects the event types it emitted (the `events_out` rows — the same stream the Floor
// consumes). A type whose source is `trunk` and that no run emitted fails the test, unless the
// table marks it `open:` with the slice that builds it and a one-line reason. The table is the
// record of what is still open.
//
// Types the table marks `agent`/`gate`/`swarm`/`floor` are emitted by other sources (EV2a) and
// are only checked for presence, never required.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { CASES_FILE, loadCases } from "./load.ts";
import { runCase, type Pools } from "./driver.ts";
import { SwarmSim, swarmFiles } from "../integration/collide/harness.ts";
import type { AgentHandle } from "../integration/collide/harness.ts";

/** EV2a: the source every event type of 12.1 belongs to. `open:` marks types a later slice builds. */
const EVENTS: Record<string, { src: "trunk" | "agent" | "gate" | "swarm" | "floor"; open?: string }> = {
  "pool.state": { src: "trunk" },
  "pool.files": { src: "trunk" },
  "pool.paused": { src: "trunk" },
  "trunk.error": { src: "trunk", open: "worker request shell (src/worker/trunk/after-commit.ts); outside the pure core" },
  "intent.created": { src: "trunk" },
  "intent.state": { src: "trunk" },
  "attempt.opened": { src: "trunk" },
  "attempt.state": { src: "trunk" },
  "attempt.reopened": { src: "trunk" },
  "attempt.step": { src: "agent" }, // EV2a: only the Agent knows model turns, tokens, cost
  "attempt.repo": { src: "agent" },
  "premise.recorded": { src: "trunk" },
  "premise.removed": { src: "trunk" },
  "premise.judged": { src: "trunk" },
  "op.recorded": { src: "trunk" },
  "op.dropped": { src: "trunk" },
  "headsup.sent": { src: "trunk" },
  "headsup.resolved": { src: "trunk" },
  "submit.result": { src: "trunk" },
  "card.opened": { src: "trunk" },
  "card.updated": { src: "trunk" },
  "card.closed": { src: "trunk" },
  "landing.accepted": { src: "trunk" },
  "landing.landed": { src: "trunk" },
  "batch.pushed": { src: "trunk" },
  "push.retry": { src: "trunk", open: "worker push loop (src/worker/trunk/push.ts); outside the pure core" },
  "tick.skipped": { src: "trunk" },
  "undo.planned": { src: "trunk" },
  "undo.refused": { src: "trunk" },
  "plain.updated": { src: "trunk", open: "plain-merge pool (PM6): the green-line slice builds it" },
  "green.verified": { src: "trunk", open: "the green line (GR5): the green-line slice builds it" },
  "green.advanced": { src: "trunk", open: "the green line (11.5): the green-line slice builds it" },
  metrics: { src: "floor" }, // EM5
  limits: { src: "gate" }, // EM6
  "swarm.state": { src: "swarm" }, // EM6
};

/** Drive one agent until it parks (a `wait` step, a `stop`, or a terminal state). */
function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    if (!sim.step(agent)) return;
  }
}

describe("event coverage (12.1, EV2a): every trunk type the engine can emit is emitted", () => {
  it("the table names every event type the protocol declares, and nothing else", () => {
    const source = readFileSync(join(REPO_ROOT, "src/protocol/events.ts"), "utf8");
    const declared = new Set([...source.matchAll(/type: "([a-z.]+)"/g)].map((m) => m[1]));
    expect([...declared].sort()).toEqual(Object.keys(EVENTS).sort());
  });

  it("collects types over every vector and the collide scenarios", () => {
    const emitted = new Set<string>();

    // Every vector of the case file, required or not: coverage collects what the engine
    // emitted; a vector's own expectations are not the check here.
    const pools = (JSON.parse(readFileSync(join(REPO_ROOT, CASES_FILE), "utf8")) as { pools: Pools }).pools;
    for (const c of loadCases().cases) {
      const sink: { types?: Set<string> } = {};
      try {
        runCase(c, pools, sink);
      } catch {
        // coverage only: a crashed vector still contributed the events written before it
      }
      for (const t of sink.types ?? []) emitted.add(t);
    }

    // The collide scenarios of test/integration/collide: a held attempt repaired by a landing,
    // the same run on a summary_only pool (EV6), and a stop.
    for (const opts of [{ seed: 7 }, { seed: 7, summary_only: true }]) {
      const sim = new SwarmSim(swarmFiles(), opts);
      const held = sim.open("add-energy", { hold: true });
      drive(sim, held);
      const rescale = sim.open("rescale-energy");
      drive(sim, rescale);
      sim.land();
      sim.release(held);
      sim.settle();
      const add = sim.open("add-plain");
      drive(sim, add);
      sim.settle();
      for (const e of sim.events()) emitted.add(String(e.type));
    }
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const a = sim.open("rescale-energy");
    drive(sim, a);
    sim.land();
    for (const e of sim.events()) emitted.add(String(e.type));

    const missing: string[] = [];
    for (const [type, row] of Object.entries(EVENTS)) {
      if (row.src !== "trunk" || row.open !== undefined) continue;
      if (!emitted.has(type)) missing.push(type);
    }
    expect(missing, `trunk-owned types never emitted: ${missing.join(", ")}`).toEqual([]);
  });
});
