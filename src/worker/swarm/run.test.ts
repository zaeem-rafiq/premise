// The launch loop of a Swarm run (01-core SWR1, 02-tidepool 10.4), driven by a fake step and a
// fake `env`: `runSwarmLaunch` holds no `cloudflare:workers` runtime import, so the unit tests
// see every step the loop records and every DO fetch the launches make.
//
// What these pin (the live-soak fix of 2026-10-06):
//   - a tick launches every due agent AT ONCE, in one `tick-<n>` step — a run's steps grow with
//     its ticks, not its agents (a Workflow instance replays completed steps on resume);
//   - the launch order of SW1: agent n is drawn with `agentRandom(seed, n)` and keeps the
//     attempt id `a_<ULID>` of `H("swarm|a_|<request_id>|<n>")` — rescale launches count in the
//     same `n` stream;
//   - a replayed tick launches the same ids again, which the DOs deduplicate (9.8).

import { describe, expect, it } from "vitest";
import type { WorkflowStep, WorkflowStepEvent } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { SwarmControlEvent, SwarmRunParams } from "../../protocol/internal.ts";
import { launchId } from "./launch.ts";
import { agentRandom } from "../../swarm/prng.ts";
import { dialPattern } from "../../swarm/dial.ts";
import { runSwarmLaunch } from "./run.ts";

// ---- The fake WorkflowStep: memoizes `do` results, replays `waitForEvent` answers ----

type WaitOutcome = { timeout: true } | { payload: SwarmControlEvent["payload"] };

/**
 * The engine's contract, shrunk to the two methods the loop uses: a `do` whose name was
 * completed returns its stored result without running the callback (replay), and a
 * `waitForEvent` replays the outcome its name recorded on the first pass. A timeout — the
 * tick's one second — advances `nowMs`, the clock the loop's `now` reads.
 */
class FakeStep {
  /** Every step name in call order, `do`s and `waitForEvent`s alike. */
  readonly calls: string[] = [];
  readonly memo: Map<string, unknown>;
  readonly waits: Map<string, WaitOutcome>;
  private readonly queue: WaitOutcome[];
  nowMs = 0;
  /** Set to flip the gate's kill switch at a chosen tick. */
  killed = false;

  constructor(
    opts: {
      queue?: WaitOutcome[];
      memo?: Map<string, unknown>;
      waits?: Map<string, WaitOutcome>;
    } = {},
  ) {
    this.queue = [...(opts.queue ?? [])];
    this.memo = opts.memo ?? new Map();
    this.waits = opts.waits ?? new Map();
  }

  now = (): number => this.nowMs;

  private do(name: string, configOrCb: unknown, maybeCb?: unknown): Promise<unknown> {
    const callback = (maybeCb ?? configOrCb) as () => Promise<unknown>;
    this.calls.push(name);
    if (this.memo.has(name)) return Promise.resolve(this.memo.get(name));
    return Promise.resolve()
      .then(() => callback())
      .then((value) => {
        this.memo.set(name, value);
        return value;
      });
  }

  private waitForEvent(name: string): Promise<WorkflowStepEvent<SwarmControlEvent["payload"]>> {
    this.calls.push(name);
    let outcome = this.waits.get(name);
    if (outcome === undefined) {
      outcome = this.queue.shift() ?? { timeout: true };
      this.waits.set(name, outcome);
    }
    if ("timeout" in outcome) {
      this.nowMs += 1_000;
      return Promise.reject(new Error("Execution timed out after 1000ms"));
    }
    return Promise.resolve({ payload: outcome.payload } as WorkflowStepEvent<SwarmControlEvent["payload"]>);
  }

  asStep(): WorkflowStep {
    return {
      do: this.do.bind(this),
      waitForEvent: this.waitForEvent.bind(this),
    } as unknown as WorkflowStep;
  }
}

// ---- The fake Durable Object namespaces the launches hit ----

type OpenRecord = { pool: string; attempt_id: string; intent_id: string };

/** The pool's Trunk: `/internal/open-attempt` opens the attempt (9.2 T1). */
class FakeTrunk {
  readonly opens: OpenRecord[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** attempt ids whose first `open-attempt` answer is a failure (a mid-tick crash fixture). */
  readonly failFirstOpen = new Set<string>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } {
    const pool = String(id);
    const trunk = this;
    return {
      async fetch(input: string, init?: RequestInit): Promise<Response> {
        trunk.inFlight += 1;
        trunk.maxInFlight = Math.max(trunk.maxInFlight, trunk.inFlight);
        try {
          await Promise.resolve();
          const path = new URL(input).pathname;
          if (path === "/internal/open-attempt") {
            const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const attemptId = String(payload.attempt_id);
            if (trunk.failFirstOpen.delete(attemptId)) {
              return Response.json({ ok: false, error: "fixture failure" });
            }
            trunk.opens.push({ pool, attempt_id: attemptId, intent_id: String(payload.intent_id) });
            return Response.json({
              ok: true,
              attempt_id: attemptId,
              change_id: `c_${attemptId}`,
              intent_id: payload.intent_id,
            });
          }
          if (path === "/internal/swarm-hold") return Response.json({ ok: true });
          if (path === "/internal/swarm-held") return Response.json({ attempts: [] });
          return new Response("not found", { status: 404 });
        } finally {
          trunk.inFlight -= 1;
        }
      },
    };
  }
}

type AgentOpenRecord = { name: string; agent_n: number; pattern: string; already: boolean };

/** The Agent Durable Object of one attempt id: `/open` is idempotent by assignment (9.8). */
class FakeAgents {
  readonly opens: AgentOpenRecord[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly assignments = new Map<string, string>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } {
    const name = String(id);
    const agents = this;
    return {
      async fetch(input: string, init?: RequestInit): Promise<Response> {
        agents.inFlight += 1;
        agents.maxInFlight = Math.max(agents.maxInFlight, agents.inFlight);
        try {
          await Promise.resolve();
          const path = new URL(input).pathname;
          if (path === "/open") {
            const payload = JSON.parse(String(init?.body)) as { agent_n: number; pattern: string };
            const key = JSON.stringify(payload);
            const already = agents.assignments.get(name) === key;
            if (!already) agents.assignments.set(name, key);
            agents.opens.push({ name, agent_n: payload.agent_n, pattern: payload.pattern, already });
            return Response.json({ ok: true, attempt_id: name, already });
          }
          return new Response("not found", { status: 404 });
        } finally {
          agents.inFlight -= 1;
        }
      },
    };
  }
}

/** The model gate: `/killed` answers the switch, `/internal/state` an empty pool registry (so an
 *  emit resolves without a Floor). */
class FakeGate {
  private readonly step: FakeStep;
  constructor(step: FakeStep) {
    this.step = step;
  }
  idFromName(): string {
    return "premise";
  }
  get(): { fetch(input: string): Promise<Response> } {
    const step = this.step;
    return {
      fetch(input: string): Promise<Response> {
        const path = new URL(input).pathname;
        if (path === "/killed") return Promise.resolve(Response.json({ killed: step.killed }));
        if (path === "/internal/state") return Promise.resolve(Response.json({ state: { pools: {} } }));
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    };
  }
}

type Fixture = { env: Env; step: FakeStep; trunk: FakeTrunk; agents: FakeAgents };

function fixture(
  over: { queue?: WaitOutcome[]; memo?: Map<string, unknown>; waits?: Map<string, WaitOutcome> } = {},
): Fixture {
  const step = new FakeStep(over);
  const trunk = new FakeTrunk();
  const agents = new FakeAgents();
  const env = {
    TRUNK: trunk,
    AGENT: agents,
    GATE: new FakeGate(step),
  } as unknown as Env;
  return { env, step, trunk, agents };
}

function runParams(over: Partial<SwarmRunParams["config"]> = {}): SwarmRunParams {
  return {
    kind: "run",
    pool: "pool-test",
    request_id: "req-run",
    config: {
      seed: 7,
      agents: 4,
      launch_per_second: 4,
      collision_dial: 0,
      think_ms: [0, 0],
      rescale_every_s: 0,
      ...over,
    },
  };
}

const aid = (requestId: string, n: number): string => launchId("a_", requestId, n);

describe("runSwarmLaunch: one step per tick launches every due agent at once (SWR1)", () => {
  it("a tick due 16 launches calls the launcher 16 times at once and records one step", async () => {
    const { env, step, trunk, agents } = fixture();
    await runSwarmLaunch(env, runParams({ agents: 16, launch_per_second: 16 }), step.asStep(), {
      now: step.now,
    });

    // The fixed steps (start, the two emissions) plus one wait and one tick step per tick — the
    // run ends on its first tick, so the launches all happened inside `tick-1`.
    expect(step.calls).toEqual(["start", "emit-ts-0", "emit-0", "control-0", "tick-1", "emit-ts-1", "emit-1"]);
    expect(trunk.opens).toHaveLength(16);
    expect(agents.opens).toHaveLength(16);
    // At once: the whole due set was in flight together, bounded by launch_per_second.
    expect(trunk.maxInFlight).toBe(16);
    expect(agents.maxInFlight).toBe(16);
    // SW1's order: agent n keeps its id and its own draw (seed 7, dial 0: n=0 is `reader`,
    // n=1 is `add-plain` — the rest follow the same draw stream).
    for (let n = 0; n < 16; n += 1) {
      expect(agents.opens[n]?.name).toBe(aid("req-run", n));
      expect(agents.opens[n]?.agent_n).toBe(n);
      expect(agents.opens[n]?.pattern).toBe(dialPattern(0, agentRandom(7, n)));
    }
    expect(agents.opens[0]?.pattern).toBe("reader");
    expect(agents.opens[1]?.pattern).toBe("add-plain");
  });

  it("a run of 1,024 agents at 16 per second takes at most 2 steps per tick plus the fixed ones", async () => {
    const { env, step, trunk, agents } = fixture();
    await runSwarmLaunch(env, runParams({ agents: 1024, launch_per_second: 16 }), step.asStep(), {
      now: step.now,
    });

    expect(trunk.opens).toHaveLength(1024);
    expect(agents.opens).toHaveLength(1024);
    expect(trunk.maxInFlight).toBe(16);
    // 64 ticks × (one `control-<n>` wait + one `tick-<n>` do) plus the five fixed steps: `start`,
    // emit-ts-0/emit-0 for `running: true`, emit-ts-1/emit-1 for `running: false`.
    const ticks = 64;
    expect(step.calls.filter((name) => name.startsWith("control-"))).toHaveLength(ticks);
    expect(step.calls.filter((name) => name.startsWith("tick-"))).toHaveLength(ticks);
    expect(step.calls).toHaveLength(2 * ticks + 5);
  });

  it("a rescale launch draws no regular quota but shares the draw stream's `n`", async () => {
    // 4 agents at 2 a second, dial 0.25, a rescale every second: tick 1 launches regulars at
    // seq 0,1 and a rescale at seq 2; tick 2 launches regulars at seq 3,4 and a rescale at 5.
    const { env, step, agents } = fixture();
    await runSwarmLaunch(
      env,
      runParams({ agents: 4, launch_per_second: 2, collision_dial: 0.25, rescale_every_s: 1 }),
      step.asStep(),
      { now: step.now },
    );

    expect(agents.opens).toHaveLength(6);
    expect(agents.opens.map((open) => open.agent_n)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(agents.opens.map((open) => open.pattern)).toEqual([
      dialPattern(0.25, agentRandom(7, 0)),
      dialPattern(0.25, agentRandom(7, 1)),
      "rescale-energy",
      dialPattern(0.25, agentRandom(7, 3)),
      dialPattern(0.25, agentRandom(7, 4)),
      "rescale-energy",
    ]);
  });

  it("a replayed tick launches the same ids, and the DOs deduplicate them (9.8)", async () => {
    // First pass: 8 agents at 4 a second; seq 5's open-attempt fails once inside `tick-2`, so
    // the run dies mid-tick after tick 1 committed seqs 0-3.
    const params = runParams({ agents: 8, launch_per_second: 4 });
    const first = fixture();
    first.trunk.failFirstOpen.add(aid("req-run", 5));
    await expect(runSwarmLaunch(first.env, params, first.step.asStep(), { now: first.step.now })).rejects.toThrow(
      /trunk_open_failed/,
    );
    expect(first.trunk.opens.map((open) => open.attempt_id)).toEqual([
      aid("req-run", 0),
      aid("req-run", 1),
      aid("req-run", 2),
      aid("req-run", 3),
      aid("req-run", 4),
      aid("req-run", 6),
      aid("req-run", 7),
    ]);

    // The resume replays the memoized steps — `tick-1` never re-runs — then re-executes `tick-2`,
    // which draws the same seqs 4-7: the same ids, answered `already` where the first pass
    // already opened them.
    const second = fixture({ memo: first.step.memo, waits: first.step.waits });
    const env = {
      TRUNK: first.trunk,
      AGENT: first.agents,
      GATE: new FakeGate(second.step),
    } as unknown as Env;
    second.step.nowMs = first.step.nowMs;
    await runSwarmLaunch(env, params, second.step.asStep(), { now: second.step.now });

    const reopened = first.trunk.opens.slice(7).map((open) => open.attempt_id);
    expect(reopened).toEqual([aid("req-run", 4), aid("req-run", 5), aid("req-run", 6), aid("req-run", 7)]);
    // Every attempt id is distinct and still in SW1 order; the re-opened ones answered `already`.
    expect(new Set(first.trunk.opens.map((open) => open.attempt_id)).size).toBe(8);
    const alreadyByName = new Map(first.agents.opens.map((open) => [open.name, open.already]));
    expect(alreadyByName.get(aid("req-run", 4))).toBe(true);
    expect(alreadyByName.get(aid("req-run", 5))).toBe(false);
  });

  it("a `stop` control event ends the run without launching the rest", async () => {
    const { env, step, trunk } = fixture({
      queue: [{ timeout: true }, { payload: { op: "stop" } }],
    });
    await runSwarmLaunch(env, runParams({ agents: 16, launch_per_second: 4 }), step.asStep(), {
      now: step.now,
    });
    // Tick 1 launched the first 4; the stop ended the run before tick 2's launches.
    expect(trunk.opens).toHaveLength(4);
  });

  it("the kill switch ends the run before that tick's launches", async () => {
    const { env, step, trunk } = fixture();
    step.killed = true;
    await runSwarmLaunch(env, runParams({ agents: 4 }), step.asStep(), { now: step.now });
    expect(trunk.opens).toHaveLength(0);
  });
});
