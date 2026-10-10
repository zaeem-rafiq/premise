// RC3/CD2: the real Trunk engine and timer runner with a controllable local
// Agent spend read. Delayed replies let new submits and closed cards overtake
// the read. No model, Artifacts, git host or Cloudflare service is bound.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { Card } from "../../../src/protocol/cards.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { waitFor } from "../trunk/harness.ts";
import { workerModules } from "../../support/bundle.ts";

const ORIGIN = "http://premise.test";
const MODEL = "@cf/openai/gpt-oss-120b";
const FIRST_COST = 0.0125;
const SECOND_COST = 0.0375;

const SPEND_AGENT = `
import { DurableObject } from "cloudflare:workers";
export class SpendAgent extends DurableObject {
  mode = "ok";
  cost = 0;
  reads = [];
  pending = [];
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/internal/state") {
      return Response.json({ reads: this.reads, pending: this.pending.length });
    }
    const body = request.method === "GET" ? {} : await request.json();
    if (path === "/internal/configure") {
      this.mode = body.mode;
      this.cost = body.cost_usd;
      return Response.json({ ok: true });
    }
    if (path === "/internal/release") {
      for (const release of this.pending.splice(0)) release();
      return Response.json({ ok: true });
    }
    if (path === "/internal/spend") {
      const mode = this.mode;
      const cost = this.cost;
      const observed = await this.env.TRUNK.get(this.env.TRUNK.idFromName(body.pool)).fetch(
        "http://premise.test/sync", {
          method: "POST",
          body: JSON.stringify({ attempt_id: body.attempt_id, ack: 0 }),
        },
      );
      this.reads.push({ body, observed: await observed.json() });
      if (mode === "delay") await new Promise((resolve) => this.pending.push(resolve));
      if (mode === "http_error") return Response.json({ error: "unavailable" }, { status: 503 });
      if (mode === "throw") throw new Error("local spend read failed");
      if (mode === "malformed") return Response.json({ ok: true, attempt_id: body.attempt_id, cost_usd: "0.0125" });
      if (mode === "negative") return Response.json({ ok: true, attempt_id: body.attempt_id, cost_usd: -1 });
      if (mode === "wrong_attempt") return Response.json({ ok: true, attempt_id: "different-attempt", cost_usd: cost });
      if (mode === "refused") return Response.json({ ok: false, error: "spend_unavailable" });
      return Response.json({ ok: true, attempt_id: body.attempt_id, cost_usd: cost });
    }
    if (path === "/push") return Response.json({ ok: true });
    return Response.json({ error: { code: "not_built" } }, { status: 404 });
  }
}
export default { fetch: () => new Response("local Agent spend fixture only", { status: 404 }) };
`;

type Event = Record<string, unknown>;
type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type ReadState = {
  reads: Array<{ body: { pool: string; attempt_id: string }; observed: { ok: boolean; attempt: { state: string } } }>;
  pending: number;
};
type Scenario = { pool: string; attempt: string; trunk: Stub; agent: Stub };

describe("race candidate settled spend in local workerd", () => {
  let worker: Miniflare;

  beforeAll(async () => {
    worker = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "premise",
            ...workerModules(),
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              TRUNK: { className: "Trunk", useSQLite: true },
              FLOOR: { className: "Floor", useSQLite: true },
              GATE: { className: "ModelGate", useSQLite: true },
              AGENT: { className: "SpendAgent", scriptName: "spend-agent" },
            },
          },
          {
            name: "spend-agent",
            modules: [
              { type: "ESModule", path: join(REPO_ROOT, ".tmp-test/race-spend-agent.mjs"), contents: SPEND_AGENT },
            ],
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              SpendAgent: { className: "SpendAgent", useSQLite: true },
              TRUNK: { className: "Trunk", scriptName: "premise" },
            },
          },
        ],
      }),
    );
    await worker.ready;
  }, 60_000);

  afterAll(async () => worker?.dispose());

  async function object(binding: string, name: string): Promise<Stub> {
    const namespace = (await worker.getDurableObjectNamespace(binding)) as unknown as Namespace;
    return namespace.get(namespace.idFromName(name));
  }

  async function post(stub: Stub, path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await stub.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function events(pool: string): Promise<Event[]> {
    const response = await (await object("FLOOR", pool)).fetch(`${ORIGIN}/api/pools/${pool}/replay.ndjson`);
    expect(response.status).toBe(200);
    return (await response.text())
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Event);
  }

  async function card(pool: string): Promise<Card> {
    const stream = await events(pool);
    const latest = stream.filter((event) => event.type === "card.opened" || event.type === "card.updated").at(-1);
    expect(latest).toBeDefined();
    return latest!.card as Card;
  }

  async function readState(scenario: Scenario): Promise<ReadState> {
    const response = await scenario.agent.fetch(`${ORIGIN}/internal/state`);
    expect(response.status).toBe(200);
    return (await response.json()) as ReadState;
  }

  async function configure(scenario: Scenario, mode: string, cost = FIRST_COST): Promise<void> {
    expect(await post(scenario.agent, "/internal/configure", { mode, cost_usd: cost })).toEqual({ ok: true });
  }

  async function prepare(name: string, mode = "ok"): Promise<Scenario> {
    const pool = `race-cost-${name}`;
    const attempt = `candidate-${name}`;
    const scenario = { pool, attempt, trunk: await object("TRUNK", pool), agent: await object("AGENT", attempt) };
    expect(
      await post(scenario.trunk, "/internal/create-pool", {
        pool,
        seed: "tidepool",
        files: {
          ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
          "base.js": "export const base = 1;\n",
        },
        summary_only: false,
        request_id: `create-${name}`,
        remote: "http://127.0.0.1:9/local-fixture",
      }),
    ).toEqual({ ok: true, pool });
    expect(
      await post(scenario.trunk, "/internal/open-attempt", {
        attempt_id: attempt,
        intent_id: `intent-${name}`,
        intent: "add a candidate constant",
        requester: "owner",
        agent_kind: "real",
        model: MODEL,
        race: true,
      }),
    ).toMatchObject({ ok: true, attempt_id: attempt });
    await configure(scenario, mode);
    return scenario;
  }

  async function tool(scenario: Scenario, name: string, args: object, call: number): Promise<Record<string, unknown>> {
    const answer = await post(scenario.trunk, "/tool", {
      attempt_id: scenario.attempt,
      call_id: `${scenario.attempt}:${call}`,
      tool: name,
      args,
      ack: 0,
    });
    expect(answer).toMatchObject({ ok: true });
    return answer.result as Record<string, unknown>;
  }

  async function submit(scenario: Scenario, value = 1, call = 1): Promise<Record<string, unknown>> {
    await tool(scenario, "write", { path: "candidate.js", content: `export const candidate = ${value};\n` }, call);
    const answer = await tool(scenario, "submit", { summary: "Add a candidate constant" }, call + 1);
    expect(answer).toMatchObject({ status: "held", tier: "auto" });
    return answer;
  }

  async function driveAlarm(scenario: Scenario): Promise<void> {
    const response = await scenario.trunk.fetch(`${ORIGIN}/internal/alarm?now=${Date.now() + 120_000}`, {
      method: "POST",
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function costJobFinished(scenario: Scenario): Promise<boolean> {
    const response = await scenario.trunk.fetch(`${ORIGIN}/internal/state`);
    const state = (await response.json()) as { meta: Record<string, string>; timers: Array<{ kind: string }> };
    return (
      (await readState(scenario)).reads.length > 0 &&
      !state.timers.some((timer) => timer.kind === "race_cost") &&
      !Object.keys(state.meta).some((key) => key.startsWith("race_cost:"))
    );
  }

  it("RC3/CD2: reads settled spend after the held transaction and publishes card.updated", async () => {
    const scenario = await prepare("success");
    await submit(scenario);
    await waitFor(async () => (await card(scenario.pool)).candidates?.[scenario.attempt]?.cost_usd === FIRST_COST);
    const state = await readState(scenario);
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0]!.body).toEqual({ pool: scenario.pool, attempt_id: scenario.attempt });
    // The spend read re-enters Trunk and observes the committed held attempt.
    expect(state.reads[0]!.observed).toMatchObject({ ok: true, attempt: { state: "held" } });
    const updates = (await events(scenario.pool)).filter((event) => event.type === "card.updated");
    const costs = updates.map((event) => (event.card as Card).candidates?.[scenario.attempt]?.cost_usd);
    expect(costs).toContain(null);
    expect(costs).toContain(FIRST_COST);
    const latest = await card(scenario.pool);
    expect(latest.candidates?.[scenario.attempt]).toMatchObject({
      state: "held",
      can_choose: true,
      cost_usd: FIRST_COST,
    });
    expect(Number.isInteger(latest.candidates?.[scenario.attempt]?.seconds)).toBe(true);
  });

  it.each(["http_error", "throw", "malformed", "negative", "wrong_attempt", "refused"])(
    "RC3: %s leaves cost unknown and does not retry the same submit",
    async (mode) => {
      const scenario = await prepare(mode, mode);
      await submit(scenario);
      await waitFor(async () => await costJobFinished(scenario));
      expect((await card(scenario.pool)).candidates?.[scenario.attempt]?.cost_usd).toBeNull();
      await configure(scenario, "ok");
      await driveAlarm(scenario);
      // CK0's unchanged duplicate submit is also not a new spend-read job.
      expect(await tool(scenario, "submit", { summary: "Add a candidate constant" }, 3)).toMatchObject({
        status: "held",
        duplicate: true,
      });
      await driveAlarm(scenario);
      expect((await readState(scenario)).reads).toHaveLength(1);
      expect((await card(scenario.pool)).candidates?.[scenario.attempt]?.cost_usd).toBeNull();
      expect((await events(scenario.pool)).some((event) => event.type === "pool.paused")).toBe(false);
    },
  );

  it("RC3: a delayed old submit cannot overwrite the replacement submit's cost", async () => {
    const scenario = await prepare("changed-submit", "delay");
    const first = await submit(scenario);
    await waitFor(async () => (await readState(scenario)).pending === 1);
    try {
      await configure(scenario, "ok", SECOND_COST);
      const second = await submit(scenario, 2, 3);
      expect(second.submit_id).not.toBe(first.submit_id);
      expect((await card(scenario.pool)).submit_ids[scenario.attempt]).toBe(second.submit_id);
    } finally {
      await post(scenario.agent, "/internal/release", {});
    }
    await waitFor(async () => (await card(scenario.pool)).candidates?.[scenario.attempt]?.cost_usd === SECOND_COST);
    const updates = (await events(scenario.pool)).filter((event) => event.type === "card.updated");
    expect(updates.some((event) => (event.card as Card).candidates?.[scenario.attempt]?.cost_usd === FIRST_COST)).toBe(
      false,
    );
    expect((await readState(scenario)).reads).toHaveLength(2);
  });

  it("RC3/CD2: a delayed spend reply leaves a closed race card alone", async () => {
    const scenario = await prepare("closed-card", "delay");
    await submit(scenario);
    await waitFor(async () => (await readState(scenario)).pending === 1);
    let closedEvents: Event[] = [];
    try {
      expect(await post(scenario.trunk, "/stop", { attempt_id: scenario.attempt, reason: "cancelled" })).toMatchObject({
        ok: true,
      });
      closedEvents = await events(scenario.pool);
      expect(closedEvents.filter((event) => event.type === "card.closed")).toMatchObject([{ action: "superseded" }]);
    } finally {
      await post(scenario.agent, "/internal/release", {});
    }
    await driveAlarm(scenario);
    await waitFor(async () => await costJobFinished(scenario));
    const finalEvents = await events(scenario.pool);
    expect(finalEvents.filter((event) => event.type === "card.updated")).toEqual(
      closedEvents.filter((event) => event.type === "card.updated"),
    );
    expect((await card(scenario.pool)).candidates?.[scenario.attempt]?.cost_usd).toBeNull();
    expect((await readState(scenario)).reads).toHaveLength(1);
  });
});
