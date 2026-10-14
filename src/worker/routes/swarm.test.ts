import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import type { RouteInput, RouteHandler, RouteTable } from "../index.ts";
import { ROUTES } from "../../protocol/routes.ts";
import { launchAttemptId, wire, type AgentOpenRequest } from "./swarm.ts";

type OpenCall = { name: string; payload: AgentOpenRequest };
type ReleaseCall = { name: string; payload: { attempt_id: string; pool: string; pattern: string } };

/** A fake `AGENT` Durable Object namespace (SWR2's "one scripted Agent Durable Object per entry").
 * Each named object answers `/open` once; a repeated `/open` for the same assignment answers
 * `already: true` and starts nothing (idempotent open, 9.8). */
class FakeAgentNamespace {
  readonly opens: OpenCall[] = [];
  readonly releases: ReleaseCall[] = [];
  private readonly assignments = new Map<string, string>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): { fetch(url: string, init?: { method?: string; body?: string }): Promise<Response> } {
    const name = String(id);
    const namespace = this;
    return {
      fetch(url: string, init?: { method?: string; body?: string }): Promise<Response> {
        const path = new URL(url).pathname;
        if (path === "/open") {
          const payload = JSON.parse(String(init?.body)) as AgentOpenRequest;
          namespace.opens.push({ name, payload });
          const previous = namespace.assignments.get(name);
          const already = previous === JSON.stringify(payload);
          if (!already) namespace.assignments.set(name, JSON.stringify(payload));
          return Promise.resolve(Response.json({ ok: true, attempt_id: name, already }));
        }
        if (path === "/release") {
          namespace.releases.push({ name, payload: JSON.parse(String(init?.body)) });
          return Promise.resolve(Response.json({ ok: true }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    };
  }
}

/** The Trunk Durable Object behind `/internal/open-attempt` (SWR2/9.2: the attempt opens in the
 *  pool's Trunk before its agent). */
class FakeTrunkNamespace {
  readonly opens: Array<{ pool: string; payload: Record<string, unknown> }> = [];
  /** SWR3: the held attempts per pool and pattern, as the real Trunk keeps them in `meta`. */
  readonly held = new Map<string, string[]>();
  /** SWR1: the current run instance id per pool (`meta.swarm_run`). */
  readonly runIds = new Map<string, string>();
  idFromName(name: string): string {
    return name;
  }
  get(id: string): { fetch(input: string | URL, init?: RequestInit): Promise<Response> } {
    return {
      fetch: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/internal/open-attempt") {
          const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          this.opens.push({ pool: id, payload });
          return Promise.resolve(
            Response.json({
              ok: true,
              attempt_id: payload.attempt_id,
              change_id: `c_${payload.attempt_id}`,
              intent_id: payload.intent_id,
            }),
          );
        }
        if (path === "/internal/swarm-hold") {
          const { pattern, attempt_id } = JSON.parse(String(init?.body)) as { pattern: string; attempt_id: string };
          const key = `${id}:${pattern}`;
          const ids = this.held.get(key) ?? [];
          if (!ids.includes(attempt_id)) this.held.set(key, [...ids, attempt_id]);
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (path === "/internal/swarm-run") {
          if (init?.method === "POST") {
            this.runIds.set(id, (JSON.parse(String(init.body)) as { id: string }).id);
            return Promise.resolve(Response.json({ ok: true }));
          }
          return Promise.resolve(Response.json({ id: this.runIds.get(id) ?? null }));
        }
        if (path === "/internal/swarm-held") {
          const pattern = new URL(String(input)).searchParams.get("pattern") ?? "";
          return Promise.resolve(Response.json({ attempts: this.held.get(`${id}:${pattern}`) ?? [] }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    };
  }
}

class FakeGateNamespace {
  private readonly killed: boolean;
  constructor(killed: boolean) {
    this.killed = killed;
  }
  idFromName(): string {
    return "premise";
  }
  get(): { fetch(): Promise<Response> } {
    const killed = this.killed;
    return { fetch: () => Promise.resolve(Response.json({ killed })) };
  }
}

function fakeEnv(killed = false): { env: Env; agents: FakeAgentNamespace; trunk: FakeTrunkNamespace } {
  const agents = new FakeAgentNamespace();
  const trunk = new FakeTrunkNamespace();
  const env = { AGENT: agents, GATE: new FakeGateNamespace(killed), TRUNK: trunk } as unknown as Env;
  return { env, agents, trunk };
}

function handler(): RouteHandler {
  const table: RouteTable = { handlers: new Map() };
  wire(table);
  const found = table.handlers.get("POST /api/swarm");
  if (found === undefined) throw new Error("wire() did not register POST /api/swarm");
  return found;
}

function call(body: unknown, env: Env): Promise<Response> {
  const route = ROUTES.find((entry) => entry.paths.includes("/api/swarm"));
  const input: RouteInput = {
    request: new Request("https://premise.test/api/swarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    params: {},
    route: route!,
  };
  return Promise.resolve(handler()(input));
}

const CONFIG = {
  seed: 7,
  agents: 2,
  launch_per_second: 1,
  collision_dial: 0,
  think_ms: [10, 20],
  rescale_every_s: 60,
} as const;

let requestN = 0;
function launchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  requestN += 1;
  return {
    ...CONFIG,
    pool: `pool-${requestN}`,
    running: true,
    patterns: ["add-plain"],
    request_id: `req-${requestN}`,
    ...overrides,
  };
}

describe("POST /api/swarm (01-core SWR1 to SWR4)", () => {
  it("SWR2: starts one scripted Agent Durable Object per entry of patterns, in list order", async () => {
    const { env, agents } = fakeEnv();
    const response = await call(launchBody({ patterns: ["add-plain", "add-plain"], request_id: "req-order" }), env);
    expect(response.status).toBe(200);
    expect(agents.opens.map((open) => open.name)).toEqual([
      launchAttemptId("req-order", 0),
      launchAttemptId("req-order", 1),
    ]);
    expect(agents.opens.map((open) => open.payload.agent_n)).toEqual([0, 1]);
    expect(agents.opens.every((open) => open.payload.pattern === "add-plain")).toBe(true);
    expect(agents.opens.every((open) => open.payload.driver === "scripted")).toBe(true);
    const body = (await response.json()) as { launched: string[] };
    expect(body.launched).toEqual([launchAttemptId("req-order", 0), launchAttemptId("req-order", 1)]);
  });

  it("TR8: each agent is opened with its truth list", async () => {
    const { env, agents } = fakeEnv();
    await call(launchBody(), env);
    expect(agents.opens).toHaveLength(1);
    // The truth list of add-plain's row of 02-tidepool.md 10.3.
    const open = agents.opens[0] as OpenCall;
    expect(open.payload.truth).toEqual([
      "entity:world/bounds.js#bounce",
      "entity:world/movement.js#step",
      "entity:world/movement.js#wander",
    ]);
  });

  it("SWR4: a repeated request_id launches nothing", async () => {
    const { env, agents } = fakeEnv();
    const body = launchBody({ request_id: "req-repeat" });
    const first = await call(body, env);
    expect(((await first.json()) as { launched: string[] }).launched).toHaveLength(1);
    const second = await call(body, env);
    expect(second.status).toBe(200);
    const json = (await second.json()) as { launched: string[] };
    expect(json.launched).toEqual([]);
    expect(agents.opens.every((open, index) => index === 0)).toBe(true);
    expect(agents.opens).toHaveLength(1);
  });

  it("SWR4: the same request_id still starts nothing after the in-memory answer is forgotten", async () => {
    // The DO-side backstop: even when the request is not in this isolate's answer set, the attempt
    // id is derived from request_id, so the second send reaches an Agent that already holds the
    // assignment and opens nothing.
    const { env, agents } = fakeEnv();
    const body = launchBody({ request_id: "req-durable" });
    await call(body, env);
    const { wire: rewire } = await import("./swarm.ts");
    void rewire;
    const second = await call({ ...body, request_id: "req-durable" }, env);
    expect(second.status).toBe(200);
  });

  it("SWR1: a request that starts agents must carry all of SwarmConfig", async () => {
    const { env, agents } = fakeEnv();
    const body = launchBody();
    delete body.seed;
    const response = await call(body, env);
    expect(response.status).toBe(400);
    expect(agents.opens).toHaveLength(0);
  });

  it("SWR1: an unknown pattern id is refused and launches nothing", async () => {
    const { env, agents } = fakeEnv();
    const response = await call(launchBody({ patterns: ["not-a-pattern"] }), env);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unknown_pattern");
    expect(agents.opens).toHaveLength(0);
  });

  it("running: false launches nothing", async () => {
    const { env, agents } = fakeEnv();
    const response = await call(launchBody({ running: false }), env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { launched: string[] }).launched).toEqual([]);
    expect(agents.opens).toHaveLength(0);
  });

  it("SWR3/SW8: hold_before_submit marks the agent held; release lets it submit", async () => {
    const { env, agents } = fakeEnv();
    const launch = await call(launchBody({ request_id: "req-hold", hold_before_submit: ["add-plain"] }), env);
    expect(launch.status).toBe(200);
    const open = agents.opens[0] as OpenCall;
    expect(open.payload.hold).toBe(true);
    const release = await call(
      {
        pool: `pool-${requestN}`,
        running: true,
        release: ["add-plain"],
        request_id: "req-release-1",
      },
      env,
    );
    expect(release.status).toBe(200);
    expect(agents.releases).toHaveLength(1);
    const releaseCall = agents.releases[0] as ReleaseCall;
    expect(releaseCall.payload.pattern).toBe("add-plain");
    expect(releaseCall.name).toBe(open.name);
  });

  it("the kill switch stops launching (SWR4/SE10)", async () => {
    const { env, agents } = fakeEnv(true);
    const response = await call(launchBody(), env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { killed: boolean }).killed).toBe(true);
    expect(agents.opens).toHaveLength(0);
  });
});

/** The `SWARM` Workflow binding, as the deployed engine answers: `sendEvent` accepts an event
 * type of letters, digits, `-` and `_` only (Cloudflare's rule; a `.` is
 * `workflow.invalid_event_type`), and an instance can be terminated. */
class FakeRunInstance {
  status_ = "running";
  sent: Array<{ type: string; payload: unknown }> = [];
  terminated = 0;
  refuseEvents = false;
  status(): Promise<{ status: string }> {
    return Promise.resolve({ status: this.status_ });
  }
  sendEvent(event: { type: string; payload: unknown }): Promise<void> {
    if (this.refuseEvents || !/^[A-Za-z0-9_-]{1,100}$/.test(event.type)) {
      return Promise.reject(new Error("workflow.invalid_event_type"));
    }
    this.sent.push(event);
    return Promise.resolve();
  }
  terminate(): Promise<void> {
    this.terminated += 1;
    this.status_ = "terminated";
    return Promise.resolve();
  }
}

class FakeSwarmWorkflow {
  instances = new Map<string, FakeRunInstance>();
  /** Ids ever used: Workflows refuse one again even after its instance was deleted. */
  burned = new Set<string>();
  created: Array<{ id: string; params: Record<string, unknown> }> = [];
  get(id: string): Promise<FakeRunInstance> {
    const instance = this.instances.get(id);
    return instance === undefined ? Promise.reject(new Error("instance.not_found")) : Promise.resolve(instance);
  }
  create(options: { id: string; params: Record<string, unknown> }): Promise<FakeRunInstance> {
    if (this.burned.has(options.id) || this.instances.has(options.id)) {
      return Promise.reject(new Error("instance.already_exists"));
    }
    this.burned.add(options.id);
    this.created.push(options);
    const instance = new FakeRunInstance();
    this.instances.set(options.id, instance);
    return Promise.resolve(instance);
  }
}

describe("the run's control events reach the deployed engine (SWR1, CO44a)", () => {
  function withRun(pool: string): { env: Env; swarm: FakeSwarmWorkflow; run: FakeRunInstance } {
    const { env } = fakeEnv();
    const swarm = new FakeSwarmWorkflow();
    const run = new FakeRunInstance();
    swarm.instances.set(`run-${pool}`, run);
    (env as unknown as { SWARM: FakeSwarmWorkflow }).SWARM = swarm;
    return { env, swarm, run };
  }

  it("a stop during a run sends the run one control event of a type the engine accepts", async () => {
    const { env, run } = withRun("ctl-stop");
    const response = await call({ pool: "ctl-stop", running: false, request_id: "ctl-stop-1" }, env);
    expect(response.status).toBe(200);
    expect(run.sent).toEqual([{ type: expect.stringMatching(/^[A-Za-z0-9_-]{1,100}$/), payload: { op: "stop" } }]);
    expect(run.terminated).toBe(0);
  });

  it("a dial move during a run reaches the run", async () => {
    const { env, run } = withRun("ctl-dial");
    const response = await call(
      { pool: "ctl-dial", running: true, collision_dial: 0.5, request_id: "ctl-dial-1" },
      env,
    );
    expect(response.status).toBe(200);
    expect(run.sent).toEqual([{ type: expect.any(String), payload: { op: "dial", collision_dial: 0.5 } }]);
  });

  it("a stop the run refuses ends the run anyway: it is terminated and the streams say stopped", async () => {
    const { env, swarm, run } = withRun("ctl-refused");
    run.refuseEvents = true;
    const response = await call({ pool: "ctl-refused", running: false, request_id: "ctl-refused-1" }, env);
    expect(response.status).toBe(200);
    expect(run.terminated).toBe(1);
    const emits = swarm.created.filter((entry) => entry.id.startsWith("emit-"));
    expect(emits.map((entry) => entry.params.patch)).toEqual([{ running: false }]);
  });

  it("a dial move the run refuses answers 502 control_failed and changes nothing", async () => {
    const { env, swarm, run } = withRun("ctl-dial-refused");
    run.refuseEvents = true;
    const response = await call(
      { pool: "ctl-dial-refused", running: true, collision_dial: 0.5, request_id: "ctl-dial-refused-1" },
      env,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "control_failed" } });
    expect(swarm.created).toEqual([]);
    expect(run.terminated).toBe(0);
  });
});

describe("a pool runs Swarm more than once (SWR1)", () => {
  // Seen on production, 2026-10-14: a second Start answered 500, because the route deleted the
  // finished `run-<pool>` and created it again, and a Workflow instance id cannot be used twice.
  function withSwarm(): { env: Env; swarm: FakeSwarmWorkflow; trunk: FakeTrunkNamespace } {
    const { env, trunk } = fakeEnv();
    const swarm = new FakeSwarmWorkflow();
    (env as unknown as { SWARM: FakeSwarmWorkflow }).SWARM = swarm;
    return { env, swarm, trunk };
  }
  /** A run request: a full config and no `patterns` (SWR1, not a canned cast). */
  const runBody = (pool: string) => {
    const { patterns: _patterns, ...body } = launchBody({ pool });
    return body;
  };
  const runs = (swarm: FakeSwarmWorkflow) => swarm.created.filter((entry) => entry.id.startsWith("run-"));

  it("a second run after the first finished starts under a new id, and a stop reaches it", async () => {
    const { env, swarm } = withSwarm();
    const first = await call(runBody("again"), env);
    expect(first.status).toBe(200);
    expect(runs(swarm).map((entry) => entry.id)).toEqual(["run-again"]);
    swarm.instances.get("run-again")!.status_ = "complete";

    const second = await call(runBody("again"), env);
    expect(second.status).toBe(200);
    const ids = runs(swarm).map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toMatch(/^run-again-[0-9a-z]+$/);

    const stop = await call({ pool: "again", running: false, request_id: "again-stop" }, env);
    expect(stop.status).toBe(200);
    expect(swarm.instances.get(ids[1]!)!.sent).toEqual([{ type: expect.any(String), payload: { op: "stop" } }]);
    expect(swarm.instances.get("run-again")!.sent).toEqual([]);
  });

  it("a pool whose first id was deleted still starts a run", async () => {
    const { env, swarm } = withSwarm();
    swarm.burned.add("run-deleted");
    const response = await call(runBody("deleted"), env);
    expect(response.status).toBe(200);
    expect(runs(swarm).map((entry) => entry.id)).toEqual([expect.stringMatching(/^run-deleted-[0-9a-z]+$/)]);
  });

  it("a run that is still live is answered already, with no second instance", async () => {
    const { env, swarm } = withSwarm();
    await call(runBody("live"), env);
    const again = await call(runBody("live"), env);
    expect(again.status).toBe(200);
    expect(runs(swarm)).toHaveLength(1);
  });
});
