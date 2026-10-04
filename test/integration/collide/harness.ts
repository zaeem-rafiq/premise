// The Node driver the collision tests use (04-build-plan.md 2.3 item 4): the real `Trunk` engine
// over `node:sqlite` — the same seam `test/cases/driver.ts` uses, no Durable Object and no
// network — on a pool seeded with the files of `tidepool-swarm`. Each scripted agent opens a
// synthetic attempt with its pattern's truth list (TR8); the driver alternates `pattern.next`
// and the engine's tool entry, delivers the heads-ups the engine recorded for that attempt
// through `sync` (SW4), and honours `hold`/`released` (SW8, SWR3).

import { DatabaseSync } from "node:sqlite";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import type { ModelToolMessage, ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import { Trunk, type Pool } from "../../../src/core/trunk/registry.ts";
import { sqlOver } from "../../cases/driver.ts";
import { patternById, type Pattern } from "../../../src/swarm/pattern.ts";
import { agentRandom } from "../../../src/swarm/prng.ts";
import type { Landing } from "../../../src/core/trunk/sets.ts";
import type { Note } from "../../../src/protocol/note.ts";
import { buildSeeds } from "../../../scripts/seeds/build.ts";

/** The files of the seed `tidepool-swarm` (scripts/seeds/build.ts, 02-tidepool.md 10.1). */
export function swarmFiles(): Record<string, string> {
  const tree = buildSeeds().get("tidepool-swarm");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool-swarm seed");
  return Object.fromEntries(tree);
}

/** The files of the stored seed `tidepool` (world/*.js is not auto there: the held tier shows). */
export function tidepoolFiles(): Record<string, string> {
  const tree = buildSeeds().get("tidepool");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool seed");
  return Object.fromEntries(tree);
}

export type AgentHandle = {
  id: string;
  pattern: Pattern;
  n: number; // its position in the cast (SW1: `agentRandom(seed, n)`)
  hold: boolean;
  released: boolean;
  delivered: number; // heads-up hns the driver has handed to the pattern (the `ack` basis, TA8)
  state: unknown;
  last: ModelToolMessage | null;
  rand: () => number; // the agent's draw stream (SW1), opened once at `open`
  calls: number;
  done: boolean;
  paused: boolean;
};

function messageOf(resp: ToolResponse): ModelToolMessage {
  if (resp.error !== undefined) return { error: resp.error };
  return { result: resp.result ?? {} };
}

export class SwarmSim {
  readonly trunk: Trunk;
  readonly db: DatabaseSync;
  readonly agents: AgentHandle[] = [];
  private readonly seed: number;

  constructor(files: Record<string, string>, opts: { seed: number; summary_only?: boolean }) {
    this.db = new DatabaseSync(":memory:");
    this.trunk = Trunk.create(sqlOver(this.db), files, {
      summary_only: opts.summary_only === true,
    });
    // PL1: the seed is batch 0 of the outbox and nothing lands before it is on Artifacts. This
    // harness has no remote, so it confirms the seed push here, as `test/cases/driver.ts` does.
    this.trunk.pushOk();
    this.seed = opts.seed;
  }

  /** Open a synthetic attempt for a pattern (SWR2: agent n is entry n of the cast). */
  open(patternId: string, opts: { hold?: boolean } = {}): AgentHandle {
    const pattern = patternById(patternId);
    if (pattern === undefined) throw new Error(`unknown pattern ${patternId}`);
    const n = this.agents.length;
    const id = `a${n}`;
    this.trunk.openAttempt(id, {
      intent: pattern.intent,
      agent_kind: "synthetic",
      truth: [...pattern.truth],
      model: null,
    });
    const agent: AgentHandle = {
      id,
      pattern,
      n,
      hold: opts.hold ?? false,
      released: false,
      delivered: 0,
      state: null,
      last: null,
      rand: agentRandom(this.seed, n),
      calls: 0,
      done: false,
      paused: false,
    };
    this.agents.push(agent);
    return agent;
  }

  /** The heads-ups the engine recorded for `agent` that it has not been handed yet (SW4). */
  private drain(agent: AgentHandle): HeadsUp[] {
    const resp = this.trunk.sync({ attempt_id: agent.id, ack: agent.delivered }) as {
      heads_ups?: HeadsUp[];
    };
    const news = (resp.heads_ups ?? []).filter((h) => h.hn > agent.delivered);
    for (const h of news) agent.delivered = Math.max(agent.delivered, h.hn);
    return news;
  }

  /**
   * One turn of one scripted agent: sync the recorded heads-ups in, run `pattern.next`, send
   * the tool call it names (with `ack` = what it has seen, TA8/TA3), or `stop` (TA9). Heads-ups
   * the tool response itself carries are served by the next `sync`, as for a real Agent.
   */
  step(agent: AgentHandle): boolean {
    if (agent.done || agent.paused) return false;
    const a = this.trunk.pool.attempts.get(agent.id);
    if (a === undefined) return false;
    if (a.state === "accepted" || a.state === "landed" || a.state === "stopped") {
      agent.done = true;
      return false;
    }
    const heads_ups = this.drain(agent);
    const step = agent.pattern.next({
      last: agent.last,
      heads_ups,
      hold: agent.hold,
      released: agent.released,
      state: agent.state,
      rand: agent.rand,
    });
    agent.state = step.state;
    agent.last = null;
    if (step.kind === "wait") return false;
    if (step.kind === "stop") {
      this.trunk.stop({ attempt_id: agent.id, reason: step.reason });
      agent.done = true;
      return true;
    }
    agent.calls += 1;
    const req: ToolRequest = {
      attempt_id: agent.id,
      call_id: `${agent.id}:${agent.calls}`,
      tool: step.tool,
      args: step.args as ToolRequest["args"],
      ack: agent.delivered,
    };
    const resp = this.trunk.tool(req);
    agent.last = messageOf(resp);
    return true;
  }

  /** One turn of every live agent, in cast order. True when any tool call or stop was sent. */
  stepAll(): boolean {
    let made = false;
    for (const agent of this.agents) made = this.step(agent) || made;
    return made;
  }

  /** The engine's accept transaction: validated candidates land, heads-ups go out (9.4). */
  land(): Pool["out"] {
    this.trunk.tick();
    const out = this.trunk.out;
    this.trunk.pushOk();
    return out;
  }

  /** Alternates `stepAll` and `land` until nothing moves (bounded). */
  settle(rounds = 60): void {
    for (let i = 0; i < rounds; i += 1) {
      const made = this.stepAll();
      const out = this.land();
      if (!made && out.landings.length === 0 && out.heads_ups.length === 0) return;
    }
    throw new Error("settle: the swarm did not come to rest");
  }

  release(agent: AgentHandle): void {
    agent.released = true;
  }

  pause(agent: AgentHandle): void {
    agent.paused = true;
  }

  resume(agent: AgentHandle): void {
    agent.paused = false;
  }

  /** Every event the engine emitted so far, as parsed `events_out` bodies, in order. */
  events(): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT body FROM events_out ORDER BY n")
      .all()
      .map((row) => JSON.parse((row as { body: string }).body) as Record<string, unknown>);
  }

  eventsOf(type: string): Array<Record<string, unknown>> {
    return this.events().filter((e) => e.type === type);
  }

  /** The heads-ups the engine recorded for `agent`, raw `HeadsUp` bodies in `hn` order. */
  headsUps(agent: AgentHandle): HeadsUp[] {
    return (this.trunk.pool.attempts.get(agent.id)?.heads ?? []).map((h) => h.body);
  }

  state(agent: AgentHandle): string | undefined {
    return this.trunk.pool.attempts.get(agent.id)?.state;
  }

  attempt(agent: AgentHandle) {
    return this.trunk.pool.attempts.get(agent.id);
  }

  files(): ReadonlyMap<string, string> {
    return this.trunk.pool.files;
  }

  /** The landing an attempt produced, or undefined while it is in flight. */
  landingOf(agent: AgentHandle): Landing | undefined {
    return this.trunk.pool.landings.find((l) => l.attempt_id === agent.id);
  }

  /** The parsed note of the attempt's landing (3.5), or undefined. */
  noteOf(agent: AgentHandle): Note | undefined {
    const l = this.landingOf(agent);
    return l === undefined ? undefined : (JSON.parse(l.note) as Note);
  }

  /** The parsed note of a landing, or undefined. */
  note(seq: number): Record<string, unknown> | undefined {
    const l = this.trunk.pool.landings.find((x) => x.seq === seq);
    return l === undefined ? undefined : (JSON.parse(l.note) as Record<string, unknown>);
  }
}
