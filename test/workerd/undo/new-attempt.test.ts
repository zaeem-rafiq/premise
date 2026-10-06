// UN6a: a refused undo resume offers a fresh real Agent on the workhorse model.
// The model provider is canned; the Agent, Trunk, Floor and local git remote are real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card } from "../../../src/protocol/cards.ts";
import { WORKHORSE_MODEL } from "../../../src/config/model-plan.ts";
import { crabFile } from "../../../src/swarm/casts/canned.ts";
import { FakeModel, type ModelScriptEntry } from "../agent/real/harness.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, openAttempt, tick, tool, waitFor } from "../collide/helpers.ts";

const POOL = "undo-new-attempt";
const SHARED = "undo-new-shared";
const CRAB = "undo-new-crab";
const INTENT = "a crab that hides when its energy drops below 30";
const READS = [
  { path: "world/energy.js", entity: "ENERGY_MAX" },
  { path: "world/bounds.js", entity: "FLOOR_Y" },
  { path: "world/bounds.js", entity: "bounce" },
  { path: "world/movement.js", entity: "step" },
];

function modelCall(name: string, args: Record<string, unknown>): ModelScriptEntry {
  return { tool_calls: [{ name, arguments: args }] };
}

describe("UN6a new attempt after an undo resume is refused", () => {
  let worker: LandingWorker;
  let model: FakeModel;
  let releaseModel: (() => void) | undefined;

  beforeAll(async () => {
    model = new FakeModel();
    await model.listen();
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL], modelUrl: model.url });
    await createPool(worker, POOL);
  }, 180_000);

  afterAll(async () => {
    releaseModel?.();
    await worker?.dispose();
    await model?.close();
  });

  it("opens exactly one fresh real Agent with the same intent, the workhorse model and a new transcript", async () => {
    await openAttempt(worker, POOL, SHARED, { intent: "make energy a fraction" });
    await tool(worker, POOL, SHARED, { tool: "read", args: READS[0]! }, 1);
    await tool(
      worker,
      POOL,
      SHARED,
      { tool: "replace", args: { path: "world/energy.js", old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" } },
      2,
    );
    await tool(worker, POOL, SHARED, { tool: "submit", args: { summary: "Make energy a fraction" } }, 3);
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 1, 30_000);

    // The test lands the old attempt directly. Its Agent is deliberately absent, so the
    // real Agent object's subsequent /resume answers attempt_unknown (RS3).
    await openAttempt(worker, POOL, CRAB, { intent: INTENT, truth: ["entity:world/energy.js#ENERGY_MAX"] });
    for (const [index, args] of READS.entries()) {
      await tool(worker, POOL, CRAB, { tool: "read", args }, index + 1);
    }
    await tool(worker, POOL, CRAB, { tool: "write", args: { path: "creatures/crab.js", content: crabFile("0.3") } }, 5);
    await tool(worker, POOL, CRAB, { tool: "submit", args: { summary: INTENT } }, 6);
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 2, 30_000);

    const undo = await worker.trunk(POOL).fetch(`/api/pools/${POOL}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1, expect_reverted: [1, 2], request_id: "undo-before-new-attempt" }),
    });
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(await undo.json()).toEqual({ ok: true, request_id: "undo-before-new-attempt" });
    await tick(worker, POOL);
    await waitFor(
      async () =>
        (await eventsOf(worker, POOL, "card.opened")).some((event) => (event.card as Card).reason === "reopen_failed"),
      30_000,
    );
    const card = (await eventsOf(worker, POOL, "card.opened"))
      .map((event) => event.card as Card)
      .find((value) => value.reason === "reopen_failed")!;
    expect(card.attempt_ids).toEqual([CRAB]);
    expect(card.options.map((option) => option.id)).toEqual(["new_attempt", "stop"]);

    model.script = [
      modelCall("list", { path: "creatures/" }),
      modelCall("read", { path: "GUIDE.md" }),
      ...READS.map((args) => modelCall("read", args)),
      modelCall("write", { path: "creatures/crab.js", content: crabFile("30") }),
      modelCall("submit", { summary: INTENT }),
    ];
    const barrier = model.hold();
    releaseModel = barrier.release;
    const action = { option: "new_attempt", submit_ids: {}, request_id: "fresh-crab" };
    for (let i = 0; i < 2; i += 1) {
      const response = await worker.fetch(`/api/pools/${POOL}/cards/${card.card_id}`, bearer(action));
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect((await barrier.seen).model).toBe(WORKHORSE_MODEL);
    const opened = (await eventsOf(worker, POOL, "attempt.opened")).filter(
      (event) => event.intent_id === card.intent_ids[0],
    );
    expect(opened).toHaveLength(2);
    const fresh = opened.find((event) => event.attempt_id !== CRAB)!;
    expect(fresh).toMatchObject({ agent: "real", model: WORKHORSE_MODEL, race: false });
    expect(fresh.change_id).not.toBe(opened.find((event) => event.attempt_id === CRAB)?.change_id);
    const freshId = String(fresh.attempt_id);
    const inspect = await worker.object("AGENT", freshId).fetch("/internal/inspect");
    expect(inspect.status).toBe(200);
    const agent = (await inspect.json()) as {
      meta: Record<string, string>;
      transcript: Array<{ role: string; content: string }>;
    };
    expect(agent.meta).toMatchObject({ model: WORKHORSE_MODEL, agent_kind: "real", revision: "1", resumed_n: "0" });
    expect(
      agent.transcript
        .filter((row) => row.role === "user")
        .map((row) => row.content)
        .join("\n"),
    ).toContain(INTENT);
    expect(agent.transcript.map((row) => row.content).join("\n")).not.toContain("reopened_dep_changed");
    expect((await worker.trunk(POOL).state()).meta).not.toHaveProperty(`new_agent_open:${freshId}`);

    barrier.release();
    await waitFor(
      async () => (await eventsOf(worker, POOL, "landing.accepted")).some((event) => event.attempt_id === freshId),
      30_000,
    );
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 4, 30_000);
    const oldState = (await eventsOf(worker, POOL, "attempt.state"))
      .filter((event) => event.attempt_id === CRAB)
      .at(-1);
    expect(oldState).toMatchObject({ to: "stopped", reason: "reopen_failed" });
    const state = await worker.trunk(POOL).state();
    expect((state.meta as Record<string, string>)[`new_agent_open:${freshId}`]).toBeUndefined();
    expect(
      (await eventsOf(worker, POOL, "attempt.opened")).filter((event) => event.intent_id === card.intent_ids[0]),
    ).toHaveLength(2);
  }, 90_000);
});
