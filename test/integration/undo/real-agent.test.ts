// Slice 13 service acceptance: the real Agent DO/model driver, Trunk, Floor and local
// stock-git remote. Only Workers AI's provider responses are canned. No hosted service.
// FEATURES.undo remains false: public-route FJ1 is covered under test/workerd/undo,
// while these enabled service requests enter the real Trunk Durable Object directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Card } from "../../../src/protocol/cards.ts";
import type { Note } from "../../../src/protocol/note.ts";
import type { UndoPlanResponse, UndoResponse } from "../../../src/protocol/undo.ts";
import { WORKHORSE_MODEL } from "../../../src/config/model-plan.ts";
import { crabFile, JELLYFISH_FILE } from "../../../src/swarm/casts/canned.ts";
import { git } from "../../git/helpers.ts";
import { FakeModel, type ModelScriptEntry } from "../../workerd/agent/real/harness.ts";
import { startLandingWorker, type LandingWorker } from "../../workerd/landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, openAttempt, tick, tool, waitFor } from "../../workerd/collide/helpers.ts";

const POOL = "undo-real-agent";
const SHARED = "undo-real-shared";
const JELLYFISH = "undo-real-jellyfish";
const CRAB_INTENT = "a crab that hides in its shell when its energy drops below 30";
const ENERGY_OLD =
  "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const ENERGY_NEW = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";

type AgentState = {
  meta: Record<string, string>;
  transcript: Array<{ step: number; role: string; tool: string | null; call_id: string | null; content: string }>;
};
type Landed = { seq: number; commit: string; note: Note };

function modelCall(name: string, args: Record<string, unknown>): ModelScriptEntry {
  return { tool_calls: [{ name, arguments: args }] };
}

describe("Slice 13 real crab Agent resume through local workerd and stock git (UN6, RS1, RS2)", () => {
  let worker: LandingWorker;
  let model: FakeModel;
  const releasePending: Array<() => void> = [];

  beforeAll(async () => {
    model = new FakeModel();
    await model.listen();
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL, `${POOL}-plain`], modelUrl: model.url });
    await createPool(worker, POOL, { seed: "tidepool" });
  }, 180_000);

  afterAll(async () => {
    for (const release of releasePending) release();
    await worker?.dispose();
    await model?.close();
  });

  async function landed(): Promise<Landed[]> {
    return (await eventsOf(worker, POOL, "landing.landed")).map((event) => ({
      seq: Number(event.seq),
      commit: String(event.commit),
      note: JSON.parse(String(event.note_json)) as Note,
    }));
  }

  async function inspect(attempt: string): Promise<AgentState> {
    const response = await worker.object("AGENT", attempt).fetch("/internal/inspect");
    expect(response.status).toBe(200);
    return (await response.json()) as AgentState;
  }

  async function plan(): Promise<UndoPlanResponse> {
    const response = await worker
      .trunk(POOL)
      .fetch(`/api/pools/${POOL}/undo-plan?q=${encodeURIComponent(JSON.stringify({ seq: 2 }))}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as UndoPlanResponse;
  }

  it("order 1: undo restores the shared rule, resumes the same crab transcript at revision 2, and lands it again", async () => {
    // The unrelated canned jellyfish lands first and must survive every undo list and tree.
    await openAttempt(worker, POOL, JELLYFISH, {
      intent: "a jellyfish that drifts up and down",
      truth: ["entity:world/bounds.js#SURFACE_Y", "entity:world/bounds.js#FLOOR_Y"],
    });
    await tool(worker, POOL, JELLYFISH, { tool: "read", args: { path: "GUIDE.md" } }, 1);
    await tool(worker, POOL, JELLYFISH, { tool: "read", args: { path: "world/bounds.js", entity: "SURFACE_Y" } }, 2);
    await tool(worker, POOL, JELLYFISH, { tool: "read", args: { path: "world/bounds.js", entity: "FLOOR_Y" } }, 3);
    await tool(
      worker,
      POOL,
      JELLYFISH,
      { tool: "write", args: { path: "creatures/jellyfish.js", content: JELLYFISH_FILE } },
      4,
    );
    await tool(worker, POOL, JELLYFISH, { tool: "submit", args: { summary: "Add the unrelated jellyfish" } }, 5);
    await tick(worker, POOL);
    await waitFor(async () => (await landed()).length === 1, 30_000);

    // The real crab executes the exact initial calls of 02 7.3. Its eighth model call
    // waits while R01 lands, making the order-1 conflict deterministic.
    model.script = [
      modelCall("list", { path: "creatures/" }),
      modelCall("read", { path: "GUIDE.md" }),
      modelCall("read", { path: "world/energy.js", entity: "ENERGY_MAX" }),
      modelCall("read", { path: "world/bounds.js", entity: "FLOOR_Y" }),
      modelCall("read", { path: "world/bounds.js", entity: "bounce" }),
      modelCall("read", { path: "world/movement.js", entity: "step" }),
      modelCall("write", { path: "creatures/crab.js", content: crabFile("30") }),
      // This harmless read receives any heads-up that arrived while the model was held.
      modelCall("read", { path: "GUIDE.md" }),
      modelCall("replace", { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" }),
      modelCall("submit", {
        summary: CRAB_INTENT,
        statement: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.",
      }),
    ];
    const barriers = Array.from({ length: 8 }, () => model.hold());
    releasePending.push(...barriers.map((barrier) => barrier.release));
    const intentResponse = await worker.fetch(
      `/api/pools/${POOL}/intents`,
      bearer({
        text: CRAB_INTENT,
        race: false,
        prewritten: false,
        request_id: "r-undo-real-crab",
      }),
    );
    expect(intentResponse.status, await intentResponse.clone().text()).toBe(200);
    const { intent_id } = (await intentResponse.json()) as { intent_id: string };
    const opened = (await eventsOf(worker, POOL, "attempt.opened")).find((event) => event.intent_id === intent_id);
    expect(opened).toBeDefined();
    const crab = String(opened!.attempt_id);
    for (const barrier of barriers.slice(0, 7)) {
      await barrier.seen;
      barrier.release();
    }
    await barriers[7]!.seen;
    expect((await inspect(crab)).transcript.some((row) => row.tool === "write")).toBe(true);

    await openAttempt(worker, POOL, SHARED, {
      intent: "make energy a fraction from 0 to 1",
      truth: ["entity:world/energy.js#ENERGY_MAX", "query:refs:world/energy.js#ENERGY_MAX"],
    });
    await tool(worker, POOL, SHARED, { tool: "read", args: { path: "GUIDE.md" } }, 1);
    await tool(worker, POOL, SHARED, { tool: "read", args: { path: "world/energy.js" } }, 2);
    await tool(
      worker,
      POOL,
      SHARED,
      { tool: "replace", args: { path: "world/energy.js", old: ENERGY_OLD, new: ENERGY_NEW } },
      3,
    );
    for (const [index, creature] of ["fish", "minnow", "turtle"].entries()) {
      await tool(
        worker,
        POOL,
        SHARED,
        { tool: "read", args: { path: `creatures/${creature}.js`, entity: "update" } },
        index + 4,
      );
    }
    const submitted = await tool(
      worker,
      POOL,
      SHARED,
      { tool: "submit", args: { summary: "Make energy a fraction from 0 to 1" } },
      7,
    );
    expect(submitted.result).toMatchObject({ status: "held" });
    const card = (await eventsOf(worker, POOL, "card.opened"))
      .map((event) => event.card as Card)
      .find((candidate) => candidate.attempt_ids.includes(SHARED));
    expect(card?.kind).toBe("held");
    const tap = await worker.fetch(
      `/api/pools/${POOL}/cards/${card!.card_id}`,
      bearer({
        option: "land",
        submit_ids: card!.submit_ids,
        request_id: "r-land-real-shared",
      }),
    );
    expect(tap.status, await tap.clone().text()).toBe(200);
    await tick(worker, POOL);
    await waitFor(async () => (await landed()).length === 2, 30_000);
    const heads = await eventsOf(worker, POOL, "headsup.sent");
    expect(heads).toContainEqual(expect.objectContaining({ attempt_id: crab, result: "repair" }));
    barriers[7]!.release();
    await waitFor(async () => (await landed()).length === 3, 60_000);
    await waitFor(async () => (await inspect(crab)).meta.state === "landed", 30_000);
    const originalLandings = await landed();
    expect(originalLandings.map((landing) => [landing.seq, landing.note.attempt?.id])).toEqual([
      [1, JELLYFISH],
      [2, SHARED],
      [3, crab],
    ]);
    const before = await inspect(crab);
    expect(before.meta.model).toBe(WORKHORSE_MODEL);
    expect(before.meta.revision).toBe("1");
    expect(
      before.transcript.some(
        (row) => row.role === "tool" && row.content.includes("heads_ups") && row.content.includes("ENERGY_MAX"),
      ),
    ).toBe(true);
    expect(await plan()).toEqual({
      ok: true,
      plan: { target_seq: 2, reverted: [2, 3], reopened: [crab], kept_readers: [], repairs: [] },
    });

    // Pause the first resumed model call, after the real Agent has synced the reopened
    // state and appended the undo heads-up. Then inspect the actual durable transcript.
    model.script = [
      modelCall("write", { path: "creatures/crab.js", content: crabFile("30") }),
      modelCall("submit", {
        summary: CRAB_INTENT,
        statement: "The undo restored energy points, so the crab again hides below 30.",
      }),
    ];
    const resumed = model.hold();
    releasePending.push(resumed.release);
    const request = { seq: 2, expect_reverted: [2, 3], request_id: "r-confirm-real-undo" };
    const confirmation = await worker.trunk(POOL).fetch(`/api/pools/${POOL}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(confirmation.status, await confirmation.clone().text()).toBe(200);
    expect((await confirmation.json()) as UndoResponse).toEqual({ ok: true, request_id: request.request_id });
    await tick(worker, POOL);
    await waitFor(async () => (await landed()).some((landing) => landing.note.kind === "undo"), 30_000);
    const resumedRequest = await resumed.seen;
    const during = await inspect(crab);
    expect(during.meta).toMatchObject({ state: "going_around", revision: "2", resumed_n: "1", model: WORKHORSE_MODEL });
    expect(during.transcript.slice(0, before.transcript.length)).toEqual(before.transcript);
    expect(during.transcript.length).toBeGreaterThan(before.transcript.length);
    const added = during.transcript.slice(before.transcript.length);
    expect(added.some((row) => row.role === "user" && row.content.includes("ENERGY_MAX"))).toBe(true);
    expect(during.transcript.map((row) => row.step)).toEqual(
      Array.from({ length: during.transcript.length }, (_, index) => index + 1),
    );
    expect(resumedRequest.model).toBe(WORKHORSE_MODEL);
    expect(await eventsOf(worker, POOL, "attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: crab, cause: "undo", revision: 2, model_changed: false }),
    ]);

    const undoLandings = (await landed()).filter((landing) => landing.note.kind === "undo");
    expect(undoLandings).toHaveLength(1);
    const undone = undoLandings[0]!;
    const directory = worker.repoDir(POOL);
    const note = JSON.parse(git(directory, ["notes", "--ref=premise", "show", undone.commit])) as Note;
    expect(note).toMatchObject({ kind: "undo", undo: { undoes: [2, 3], reopened: [crab], kept_readers: [] } });
    const trailers = git(
      directory,
      ["interpret-trailers", "--parse"],
      git(directory, ["show", "-s", "--format=%B", undone.commit]),
    );
    expect(trailers.split("\n").filter((line) => line.startsWith("Undoes:"))).toEqual([
      `Undoes: ${originalLandings[1]!.commit}`,
      `Undoes: ${originalLandings[2]!.commit}`,
    ]);
    expect(git(directory, ["show", `${undone.commit}:world/energy.js`])).toContain("export const ENERGY_MAX = 100;");
    expect(git(directory, ["ls-tree", "-r", "--name-only", undone.commit]).split("\n")).not.toContain(
      "creatures/crab.js",
    );
    expect(git(directory, ["show", `${undone.commit}:creatures/jellyfish.js`])).toBe(JELLYFISH_FILE.trimEnd());

    resumed.release();
    await waitFor(
      async () => (await landed()).some((landing) => landing.note.attempt?.id === crab && landing.note.revision === 2),
      60_000,
    );
    const all = await landed();
    expect(all.filter((landing) => landing.note.kind === "undo")).toHaveLength(1);
    const crabAgain = all.find((landing) => landing.note.attempt?.id === crab && landing.note.revision === 2)!;
    expect(crabAgain.note.attempt?.model).toBe(WORKHORSE_MODEL);
    expect(crabAgain.note.attempt?.agent).toBe("real");
    expect(crabAgain.note.change_id).toBe(originalLandings[2]!.note.change_id);
    expect(git(directory, ["show", `${crabAgain.commit}:creatures/crab.js`])).toContain("crab.energy < 30");
    expect(git(directory, ["show", "-s", "--format=%an", crabAgain.commit])).toBe(WORKHORSE_MODEL);
    expect(() => git(directory, ["fsck", "--strict"])).not.toThrow();
    const failures = await eventsOf(worker, POOL, "trunk.error");
    expect(failures).toEqual([]);
  }, 240_000);
});
