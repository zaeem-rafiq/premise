// RC1/9.8/FJ1: the actual public route, Trunk and Floor in local workerd. Only
// Agent execution is replaced: the recording Agent reads the committed Floor
// stream on /open and records one launch per object, like the real Agent.
// Both fixtures set FEATURES.race in memory only (`withFeatures`), whatever the build
// ships. No model, Artifacts, git host or Cloudflare service is bound.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { Card } from "../../../src/protocol/cards.ts";
import type { AgentOpenRequest } from "../../../src/protocol/internal.ts";
import { RACE_SIZE } from "../../../src/protocol/constants.ts";
import { MODEL_PLAN } from "../../../src/config/model-plan.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { bearer, KEY } from "../collide/helpers.ts";
import { withFeatures } from "../../support/features.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const ORIGIN = "http://premise.test";
// S5/MG2's model order, independent of the route's output.
const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.3-flash"];
const POOL = "race-intent-enabled";
const REQUEST = {
  text: "a jellyfish that drifts up and down",
  race: true,
  prewritten: true,
  request_id: "race-intent-request",
};

const RECORDING_AGENT = `
import { DurableObject } from "cloudflare:workers";
export class RecordingAgent extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/internal/state") {
      return Response.json({ launches: (await this.ctx.storage.get("launches")) ?? [] });
    }
    if (path === "/open") {
      const body = await request.json();
      await this.ctx.blockConcurrencyWhile(async () => {
        if (await this.ctx.storage.get("launches")) return;
        const floor = this.env.FLOOR.get(this.env.FLOOR.idFromName(body.pool));
        const response = await floor.fetch("http://premise.test/api/pools/" + body.pool + "/replay.ndjson");
        const events = (await response.text()).trim().split("\\n").slice(1).map((line) => JSON.parse(line));
        await this.ctx.storage.put("launches", [{ object_name: this.ctx.id.name, body, events }]);
      });
      return Response.json({ ok: true });
    }
    if (path === "/push") return Response.json({ ok: true });
    return Response.json({ error: { code: "not_built" } }, { status: 404 });
  }
}
export default { fetch: () => new Response("recording Agent only", { status: 404 }) };
`;

type Event = Record<string, unknown>;
type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Launch = { object_name: string; body: AgentOpenRequest; events: Event[] };

async function startWorker(contents: string): Promise<Miniflare> {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE, contents }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { OWNER_KEY: KEY },
          durableObjects: {
            TRUNK: { className: "Trunk", useSQLite: true },
            FLOOR: { className: "Floor", useSQLite: true },
            GATE: { className: "ModelGate", useSQLite: true },
            AGENT: { className: "RecordingAgent", scriptName: "recording-agent" },
          },
        },
        {
          name: "recording-agent",
          modules: [
            {
              type: "ESModule",
              path: join(REPO_ROOT, ".tmp-test/race-recording-agent.mjs"),
              contents: RECORDING_AGENT,
            },
          ],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            RecordingAgent: { className: "RecordingAgent", useSQLite: true },
            FLOOR: { className: "Floor", scriptName: "premise" },
          },
        },
      ],
    }),
  );
  await worker.ready;
  return worker;
}

async function object(worker: Miniflare, binding: string, name: string): Promise<Stub> {
  const namespace = (await worker.getDurableObjectNamespace(binding)) as unknown as Namespace;
  return namespace.get(namespace.idFromName(name));
}

async function createPool(worker: Miniflare, pool: string): Promise<void> {
  const trunk = await object(worker, "TRUNK", pool);
  const response = await trunk.fetch(`${ORIGIN}/internal/create-pool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pool,
      seed: "tidepool",
      files: { "README.md": "Local race route fixture.\n" },
      summary_only: false,
      request_id: `create-${pool}`,
      remote: "http://127.0.0.1:9/local-fixture",
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function events(worker: Miniflare, pool: string): Promise<Event[]> {
  const floor = await object(worker, "FLOOR", pool);
  const response = await floor.fetch(`${ORIGIN}/api/pools/${pool}/replay.ndjson`);
  expect(response.status).toBe(200);
  return (await response.text())
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Event);
}

function intentEvents(stream: Event[]): Event[] {
  return stream.filter((event) =>
    ["intent.created", "attempt.opened", "card.opened", "card.updated"].includes(String(event.type)),
  );
}

async function launches(worker: Miniflare, attemptId: string): Promise<Launch[]> {
  const agent = await object(worker, "AGENT", attemptId);
  const response = await agent.fetch(`${ORIGIN}/internal/state`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { launches: Launch[] }).launches;
}

describe("race intent public handler with real Trunk and an in-memory feature fixture", () => {
  let enabled: Miniflare;
  let disabled: Miniflare;
  let original: string;

  beforeAll(async () => {
    original = readFileSync(BUNDLE, "utf8");
    enabled = await startWorker(withFeatures(original, { race: true }));
    await createPool(enabled, POOL);
    disabled = await startWorker(withFeatures(original, { race: false }));
    await createPool(disabled, "race-intent-disabled");
  }, 60_000);

  afterAll(async () => {
    await enabled?.dispose();
    await disabled?.dispose();
  });

  it("RC1/13.6/S5: opens one intent and all three ordered race candidates at Trunk before their own Agents", async () => {
    expect(RACE_SIZE).toBe(3);
    expect(MODEL_PLAN.race).toEqual(MODELS);
    const response = await enabled.dispatchFetch(`${ORIGIN}/api/pools/${POOL}/intents`, bearer(REQUEST) as never);
    expect(response.status, await response.clone().text()).toBe(200);
    const answer = (await response.json()) as { intent_id: string };
    expect(answer).toEqual({ intent_id: expect.stringMatching(/^i_[0-9A-HJKMNP-TV-Z]{26}$/) });

    const stream = await events(enabled, POOL);
    const created = stream.filter((event) => event.type === "intent.created");
    const opened = stream.filter((event) => event.type === "attempt.opened");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      intent_id: answer.intent_id,
      text: REQUEST.text,
      requester: "owner",
      race: true,
      prewritten: true,
    });
    expect(opened).toHaveLength(3);
    expect(opened.map((event) => event.model)).toEqual(MODELS);
    expect(new Set(opened.map((event) => event.attempt_id)).size).toBe(3);
    expect(new Set(opened.map((event) => event.change_id)).size).toBe(3);
    expect(stream.indexOf(created[0]!)).toBeLessThan(stream.indexOf(opened[0]!));
    for (const event of opened) {
      expect(event).toMatchObject({ intent_id: answer.intent_id, race: true, agent: "real" });
      expect(event.attempt_id).toMatch(/^a_[0-9A-HJKMNP-TV-Z]{26}$/);
    }

    const cardEvents = stream.filter((event) => event.type === "card.opened" || event.type === "card.updated");
    expect(cardEvents.filter((event) => event.type === "card.opened")).toHaveLength(1);
    const card = cardEvents.at(-1)!.card as Card;
    expect(card.kind).toBe("race");
    expect(card.attempt_ids).toEqual(opened.map((event) => event.attempt_id));
    expect(card.options.map((option) => option.id)).toEqual(["choose"]);
    for (const attemptId of card.attempt_ids) {
      expect(card.candidates?.[attemptId]).toMatchObject({
        state: "opened",
        can_choose: false,
        seconds: null,
        cost_usd: null,
      });
    }

    for (const [index, event] of opened.entries()) {
      const recorded = await launches(enabled, String(event.attempt_id));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        object_name: event.attempt_id,
        body: {
          pool: POOL,
          attempt_id: event.attempt_id,
          intent_id: answer.intent_id,
          change_id: event.change_id,
          intent_text: REQUEST.text,
          requester: "owner",
          agent_kind: "real",
          driver: "model",
          model: MODELS[index],
        },
      });
      // This snapshot was taken inside Agent /open, before that Agent recorded a launch.
      expect(recorded[0]!.events.filter((item) => item.type === "attempt.opened")).toEqual(opened);
      const observedCards = recorded[0]!.events.filter(
        (item) => item.type === "card.opened" || item.type === "card.updated",
      );
      expect(observedCards.at(-1)?.card).toEqual(card);
    }

    // 9.8 returns the first answer even if a caller reuses the id with changed fields.
    for (const retry of [REQUEST, { ...REQUEST, text: "a different intent", race: false, prewritten: false }]) {
      const repeated = await enabled.dispatchFetch(`${ORIGIN}/api/pools/${POOL}/intents`, bearer(retry) as never);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(answer);
      expect(intentEvents(await events(enabled, POOL))).toEqual(intentEvents(stream));
      for (const event of opened) {
        const recorded = await launches(enabled, String(event.attempt_id));
        expect(recorded).toHaveLength(1);
        expect(recorded[0]!.body.intent_text).toBe(REQUEST.text);
        expect(recorded[0]!.body.model).toBe(event.model);
      }
    }
  });

  it("FJ1: race disabled answers 404 feature_off and never reaches Trunk or launches candidates", async () => {
    const pool = "race-intent-disabled";
    const trunk = await object(disabled, "TRUNK", pool);
    const beforeState = (await (await trunk.fetch(`${ORIGIN}/internal/state`)).json()) as { served: unknown };
    const beforeEvents = intentEvents(await events(disabled, pool));
    const response = await disabled.dispatchFetch(`${ORIGIN}/api/pools/${pool}/intents`, bearer(REQUEST) as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "feature_off" } });
    const afterState = (await (await trunk.fetch(`${ORIGIN}/internal/state`)).json()) as { served: unknown };
    expect(afterState.served).toEqual(beforeState.served);
    expect(intentEvents(await events(disabled, pool))).toEqual(beforeEvents);
    expect(beforeEvents).toEqual([]);
  });

  it("the enabled fixture leaves the built bundle unchanged on disk", () => {
    expect(readFileSync(BUNDLE, "utf8")).toBe(original);
  });
});
