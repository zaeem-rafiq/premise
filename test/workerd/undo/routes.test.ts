// Slice 13: owner guards and FJ1 through the built Worker, and UN4/UN5 through its
// real Trunk object. The Worker runs with undo off (`features: { undo: false }`, whatever the
// build ships), so enabled service behavior is exercised through the internal object boundary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UndoPlanResponse, UndoResponse } from "../../../src/protocol/undo.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, openAttempt, tick, tool, waitFor } from "../collide/helpers.ts";

import { git } from "../../git/helpers.ts";

const POOL = "undo-routes";
const PLAN = `/api/pools/${POOL}/undo-plan`;
const UNDO = `/api/pools/${POOL}/undo`;
const ENERGY = ["entity:world/energy.js#ENERGY_MAX"];

describe("Slice 13 undo routes in local workerd (UN4, UN5, FJ1, SE2, SE3)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    // These tests check the routes with undo off (FJ1), whatever the build ships.
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL], agentStub: true, features: { undo: false } });
    await createPool(worker, POOL);
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("SE2: both undo routes require the owner credential before reaching Trunk", async () => {
    for (const authorization of [undefined, "Bearer wrong-owner-key"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (authorization !== undefined) headers.authorization = authorization;
      const plan = await worker.fetch(`${PLAN}?seq=1`, { headers });
      expect(plan.status).toBe(401);
      expect(await plan.json()).toEqual({ error: { code: "unauthorized" } });
      const undo = await worker.fetch(UNDO, {
        method: "POST",
        headers,
        body: JSON.stringify({ seq: 1, expect_reverted: [1], request_id: "unauthorized" }),
      });
      expect(undo.status).toBe(401);
      expect(await undo.json()).toEqual({ error: { code: "unauthorized" } });
    }
  });

  it("SE3: undo rejects a non-JSON body before authentication", async () => {
    const response = await worker.fetch(UNDO, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "seq=1",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: { code: "unsupported_media_type" } });
  });

  it("SE3: cookie-authenticated undo requires the Floor Origin", async () => {
    const session = await worker.fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeDefined();
    for (const origin of [undefined, "https://other.example"]) {
      const headers: Record<string, string> = { "content-type": "application/json", cookie: cookie! };
      if (origin !== undefined) headers.origin = origin;
      const response = await worker.fetch(UNDO, {
        method: "POST",
        headers,
        body: JSON.stringify({ seq: 1, expect_reverted: [1], request_id: "wrong-origin" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "forbidden" } });
    }
    const acceptedOrigin = await worker.fetch(UNDO, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie!, origin: "http://premise.test" },
      body: JSON.stringify({ seq: 1, expect_reverted: [1], request_id: "right-origin" }),
    });
    expect(acceptedOrigin.status).toBe(404);
    expect(await acceptedOrigin.json()).toEqual({ error: { code: "feature_off" } });
  });

  it("FJ1: both owner undo routes answer 404 feature_off and change nothing", async () => {
    const before = await worker.trunk(POOL).state();
    const beforeEvents = await worker.events(POOL);
    const plan = await worker.fetch(`${PLAN}?seq=1`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(plan.status).toBe(404);
    expect(await plan.json()).toEqual({ error: { code: "feature_off" } });
    const undo = await worker.fetch(UNDO, bearer({ seq: 1, expect_reverted: [1], request_id: "feature-off" }));
    expect(undo.status).toBe(404);
    expect(await undo.json()).toEqual({ error: { code: "feature_off" } });
    const after = await worker.trunk(POOL).state();
    expect(after.landings).toEqual(before.landings);
    expect((after.meta as Record<string, string>).head_seq).toBe((before.meta as Record<string, string>).head_seq);
    expect(await worker.events(POOL)).toEqual(beforeEvents);
  });

  it("UN4/UN5: Trunk returns the current plan, rejects a stale confirmation, and deduplicates an accepted request", async () => {
    const readPlan = async (seq: number): Promise<UndoPlanResponse> => {
      const response = await worker.trunk(POOL).fetch(`${PLAN}?q=${encodeURIComponent(JSON.stringify({ seq }))}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as UndoPlanResponse;
    };
    const confirm = async (expect_reverted: number[], request_id: string): Promise<UndoResponse> => {
      const response = await worker.trunk(POOL).fetch(UNDO, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: 1, expect_reverted, request_id }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as UndoResponse;
    };

    expect(await readPlan(999)).toEqual({ ok: false, reason: "not_a_change" });
    await openAttempt(worker, POOL, "undo-shared", { intent: "make energy a fraction", truth: ENERGY });
    await tool(
      worker,
      POOL,
      "undo-shared",
      { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } },
      1,
    );
    await tool(
      worker,
      POOL,
      "undo-shared",
      {
        tool: "replace",
        args: { path: "world/energy.js", old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" },
      },
      2,
    );
    await tool(worker, POOL, "undo-shared", { tool: "submit", args: { summary: "Make energy a fraction" } }, 3);
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 1, 30_000);
    expect(await readPlan(1)).toEqual({
      ok: true,
      plan: { target_seq: 1, reverted: [1], reopened: [], kept_readers: [], repairs: [] },
    });

    await openAttempt(worker, POOL, "undo-crab", { intent: "add a crab", truth: ENERGY });
    await worker.object("AGENT", "undo-crab").fetch("/internal/mode", {
      method: "POST",
      body: JSON.stringify({ mode: "ack" }),
    });
    await tool(worker, POOL, "undo-crab", { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } }, 1);
    await tool(
      worker,
      POOL,
      "undo-crab",
      {
        tool: "write",
        args: {
          path: "creatures/crab.js",
          content:
            'import { ENERGY_MAX } from "../world/energy.js";\nexport function spawn() { return { energy: ENERGY_MAX }; }\nexport function update(crab) { crab.hiding = crab.energy < 0.3; }\n',
        },
      },
      2,
    );
    await tool(worker, POOL, "undo-crab", { tool: "submit", args: { summary: "Add a crab" } }, 3);
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 2, 30_000);

    const plan = { target_seq: 1, reverted: [1, 2], reopened: ["undo-crab"], kept_readers: [], repairs: [] };
    expect(await readPlan(1)).toEqual({ ok: true, plan });
    expect(await confirm([1], "stale-plan")).toEqual({ ok: false, reason: "plan_changed", plan });
    await tick(worker, POOL);
    expect(await eventsOf(worker, POOL, "undo.planned")).toEqual([]);
    expect(await eventsOf(worker, POOL, "landing.landed")).toHaveLength(2);

    expect(await confirm([1, 2], "confirmed-plan")).toEqual({ ok: true, request_id: "confirmed-plan" });
    expect(await confirm([1, 2], "confirmed-plan")).toEqual({ ok: true, request_id: "confirmed-plan" });
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length === 3, 30_000);
    expect(await eventsOf(worker, POOL, "undo.planned")).toHaveLength(1);
    const landings = await eventsOf(worker, POOL, "landing.landed");
    const undoLanding = landings.find((l) => JSON.parse(String(l.note_json)).kind === "undo")!;
    const directory = worker.repoDir(POOL);
    const undoCommit = String(undoLanding.commit);
    const note = JSON.parse(git(directory, ["notes", "--ref=premise", "show", undoCommit]));
    expect(note).toMatchObject({ kind: "undo", undo: { undoes: [1, 2], reopened: ["undo-crab"], kept_readers: [] } });
    const targetNote = JSON.parse(git(directory, ["notes", "--ref=premise", "show", String(landings[0]!.commit)]));
    const trailers = git(
      directory,
      ["interpret-trailers", "--parse"],
      git(directory, ["show", "-s", "--format=%B", undoCommit]),
    );
    expect(trailers.split("\n").filter((line) => line.startsWith("Undoes:"))).toEqual([
      `Undoes: ${landings[0]!.commit}`,
      `Undoes: ${landings[1]!.commit}`,
    ]);
    expect(trailers).toContain(`Intent-Id: ${targetNote.intent.id}`);
    expect(note.intent).toEqual(targetNote.intent);
    expect(note.change_id).not.toBe(targetNote.change_id);
    expect(git(directory, ["show", `${undoCommit}:world/energy.js`])).toContain("ENERGY_MAX = 100");
    expect(git(directory, ["ls-tree", "-r", "--name-only", undoCommit])).not.toContain("creatures/crab.js");
    expect(() => git(directory, ["fsck", "--strict"])).not.toThrow();
    expect(await eventsOf(worker, POOL, "attempt.reopened")).toEqual([
      expect.objectContaining({ attempt_id: "undo-crab", cause: "undo", revision: 2, model_changed: false }),
    ]);
    const agent = await worker.object("AGENT", "undo-crab").state();
    expect(agent.resumes).toEqual([{ attempt_id: "undo-crab", revision: 2, cause: "undo", resume_n: 1 }]);

    expect(await readPlan(1)).toEqual({ ok: false, reason: "already_undone" });
    expect(await readPlan(3)).toEqual({ ok: false, reason: "not_a_change" });
    expect(await confirm([1, 2], "confirmed-plan")).toEqual({ ok: true, request_id: "confirmed-plan" });
    expect(await eventsOf(worker, POOL, "landing.landed")).toHaveLength(3);
  }, 90_000);
});
