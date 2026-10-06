// Slice 12 service acceptance: actual public routes, three real Agent objects,
// Trunk, Floor, model gate and stock-git remotes. Only provider answers are canned.
// The race flag changes in memory for this test file, using the same fixture
// convention as the workerd route tests. No production config or bundle is edited.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card } from "../../../src/protocol/cards.ts";
import type { Note } from "../../../src/protocol/note.ts";
import type { AgentSpendResponse } from "../../../src/protocol/internal.ts";
import { git } from "../../git/helpers.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { FakeModel, type ModelScriptEntry } from "../../workerd/agent/real/harness.ts";
import { startLandingWorker, type LandingWorker } from "../../workerd/landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, openAttempt, tick, tool, waitFor } from "../../workerd/collide/helpers.ts";

vi.mock("miniflare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("miniflare")>();
  const { readFileSync: read } = await import("node:fs");
  return {
    ...actual,
    convertV4MiniflareOptions(options: Parameters<typeof actual.convertV4MiniflareOptions>[0]) {
      // File-scoped Vitest isolation confines this wrapper to the race acceptance.
      const workers = ("workers" in options ? options.workers : [options]) as Array<{
        name?: string;
        modules?: boolean | Array<{ type: string; path: string; contents?: string }>;
      }>;
      for (const worker of workers) {
        if (worker.name !== "premise" || !Array.isArray(worker.modules)) continue;
        for (const module of worker.modules) {
          if (module.type !== "ESModule" || !module.path.endsWith("/dist/worker/index.js")) continue;
          const source = read(module.path, "utf8");
          const blocks = source.match(/var FEATURES = \{[\s\S]*?\n\};/g) ?? [];
          if (blocks.length !== 1 || (blocks[0]!.match(/\brace: false,/g) ?? []).length !== 1) {
            throw new Error("Expected exactly one disabled race flag in the built FEATURES object");
          }
          module.contents = source.replace(blocks[0]!, blocks[0]!.replace("race: false,", "race: true,"));
        }
      }
      return actual.convertV4MiniflareOptions(options);
    },
  };
});

const POOL = "race-real-agents";
const INTENT = "compare three small candidate markers";
const OUTSIDER = "race-conflicting-change";
const REASON = "Keep the shared beta marker because it names the chosen design.";
const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
// S5/MG2 and the fake's declared default usage: three calls, each 1000 input
// tokens and 60 output tokens. Expected costs are computed independently here.
const CANDIDATES = [
  {
    model: "@cf/openai/gpt-oss-120b",
    path: "creatures/race-alpha.js",
    content: 'export const marker = "alpha";\n',
    tier: "auto",
    cost: 0.001185,
  },
  {
    model: "@cf/moonshotai/kimi-k2.7-code",
    path: "world/race-beta.js",
    content: 'export const marker = "beta";\n',
    tier: "held",
    cost: 0.00357,
  },
  {
    model: "@cf/zai-org/glm-5.3-flash",
    path: "creatures/race-gamma.js",
    content: 'export const marker = "gamma";\n',
    tier: "auto",
    cost: 0.00054,
  },
];

type AgentState = { meta: Record<string, string>; transcript: Array<{ tool: string | null; content: string }> };
type Landing = { seq: number; commit: string; note: Note };

function modelCall(name: string, args: Record<string, unknown>): ModelScriptEntry {
  return { tool_calls: [{ name, arguments: args }] };
}

describe("Slice 12 race and choose through real Agents, local workerd and stock git", () => {
  let worker: LandingWorker;
  let model: FakeModel;
  let originalBundle: string;
  const releasePending: Array<() => void> = [];

  beforeAll(async () => {
    originalBundle = readFileSync(BUNDLE, "utf8");
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

  async function inspect(attempt: string): Promise<AgentState> {
    const response = await worker.object("AGENT", attempt).fetch("/internal/inspect");
    expect(response.status).toBe(200);
    return (await response.json()) as AgentState;
  }

  async function landed(): Promise<Landing[]> {
    return (await eventsOf(worker, POOL, "landing.landed")).map((event) => ({
      seq: Number(event.seq),
      commit: String(event.commit),
      note: JSON.parse(String(event.note_json)) as Note,
    }));
  }

  async function raceCard(): Promise<Card> {
    const stream = await worker.events(POOL);
    const event = stream
      .filter(
        (item) => (item.type === "card.opened" || item.type === "card.updated") && (item.card as Card).kind === "race",
      )
      .at(-1);
    expect(event).toBeDefined();
    return event!.card as Card;
  }

  async function spend(attempt: string, body: { pool: string; attempt_id: string }): Promise<AgentSpendResponse> {
    const response = await worker.object("AGENT", attempt).fetch("/internal/spend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as AgentSpendResponse;
  }

  it("RC1-RC5/CD1: three models wait on one card, a go-around cannot be chosen, and the chosen held-tier candidate lands", async () => {
    // All first requests pause before consuming the shared provider script. Each
    // model is then released alone through its three declared tool calls.
    const barriers = Array.from({ length: 3 }, () => model.hold());
    releasePending.push(...barriers.map((barrier) => barrier.release));
    const response = await worker.fetch(
      `/api/pools/${POOL}/intents`,
      bearer({
        text: INTENT,
        race: true,
        prewritten: false,
        request_id: "race-real-intent",
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const answer = (await response.json()) as { intent_id: string };
    const initialRequests = await Promise.all(barriers.map((barrier) => barrier.seen));
    expect(initialRequests.map((request) => request.model).sort()).toEqual(
      CANDIDATES.map((candidate) => candidate.model).sort(),
    );

    const intents = await eventsOf(worker, POOL, "intent.created");
    expect(intents).toEqual([
      expect.objectContaining({ intent_id: answer.intent_id, text: INTENT, race: true, prewritten: false }),
    ]);
    const opened = await eventsOf(worker, POOL, "attempt.opened");
    expect(opened).toHaveLength(3);
    expect(opened.map((event) => event.model)).toEqual(CANDIDATES.map((candidate) => candidate.model));
    expect(new Set(opened.map((event) => event.attempt_id)).size).toBe(3);
    for (const event of opened) expect(event).toMatchObject({ intent_id: answer.intent_id, agent: "real", race: true });
    const ids = opened.map((event) => String(event.attempt_id));
    const [alpha, beta, gamma] = ids as [string, string, string];
    const originalCard = await raceCard();
    expect(originalCard.attempt_ids).toEqual(ids);
    expect(originalCard.options.map((option) => option.id)).toEqual(["choose"]);

    for (const [index, candidate] of CANDIDATES.entries()) {
      const attempt = ids[index]!;
      model.script = [
        modelCall("read", { path: "GUIDE.md" }),
        modelCall("write", { path: candidate.path, content: candidate.content }),
        modelCall("submit", { summary: `Add the ${candidate.model} candidate marker` }),
      ];
      const barrierIndex = initialRequests.findIndex((request) => request.model === candidate.model);
      barriers[barrierIndex]!.release();
      await waitFor(async () => {
        const card = await raceCard();
        return card.candidates?.[attempt]?.can_choose === true && card.candidates[attempt]!.cost_usd !== null;
      }, 30_000);
      expect(model.script).toEqual([]);
      await waitFor(async () => (await inspect(attempt)).meta.state === "held");
      const state = await inspect(attempt);
      expect(state.meta).toMatchObject({ state: "held", model: candidate.model });
      expect(state.transcript.filter((row) => row.tool !== null).map((row) => row.tool)).toEqual([
        "read",
        "write",
        "submit",
      ]);
      const submitted = (await eventsOf(worker, POOL, "submit.result")).filter((event) => event.attempt_id === attempt);
      expect(submitted).toEqual([expect.objectContaining({ status: "held", tier: candidate.tier })]);
      expect(model.requests.filter((request) => request.model === candidate.model)).toHaveLength(3);
    }

    const ready = await raceCard();
    expect(ready.card_id).toBe(originalCard.card_id);
    expect(
      (await eventsOf(worker, POOL, "card.opened")).filter((event) => (event.card as Card).kind === "race"),
    ).toHaveLength(1);
    expect(await landed()).toEqual([]);
    for (const [index, candidate] of CANDIDATES.entries()) {
      const attempt = ids[index]!;
      const row = ready.candidates![attempt]!;
      expect(row).toMatchObject({ state: "held", can_choose: true });
      expect(Number.isInteger(row.seconds)).toBe(true);
      expect(row.seconds).toBeGreaterThanOrEqual(0);
      expect(row.cost_usd).toBeCloseTo(candidate.cost, 12);
      const read = await spend(attempt, { pool: POOL, attempt_id: attempt });
      expect(read).toMatchObject({ ok: true, attempt_id: attempt });
      expect((read as { cost_usd: number }).cost_usd).toBeCloseTo(candidate.cost, 12);
      expect(await spend(attempt, { pool: "another-pool", attempt_id: attempt })).toEqual({
        ok: false,
        error: "attempt_unknown",
      });
      expect(await spend(attempt, { pool: POOL, attempt_id: "another-attempt" })).toEqual({
        ok: false,
        error: "attempt_unknown",
      });
    }
    expect(model.requests).toHaveLength(9);
    await waitFor(async () => {
      const gateResponse = await worker.object("GATE", "premise").fetch("/internal/state");
      const gate = (await gateResponse.json()) as { state: { slots: Record<string, unknown> } };
      return Object.keys(gate.state.slots).length === 0;
    });

    // A real conflicting landing invalidates alpha's new-file operation. The
    // real alpha Agent receives the repair, but its next model answer is held.
    const repair = model.hold();
    releasePending.push(repair.release);
    model.script = [modelCall("read", { path: "GUIDE.md" })];
    await openAttempt(worker, POOL, OUTSIDER, { intent: "occupy alpha's candidate path" });
    await tool(worker, POOL, OUTSIDER, { tool: "read", args: { path: "GUIDE.md" } }, 1);
    await tool(
      worker,
      POOL,
      OUTSIDER,
      { tool: "write", args: { path: CANDIDATES[0]!.path, content: 'export const marker = "already-landed";\n' } },
      2,
    );
    const competingSubmit = await tool(
      worker,
      POOL,
      OUTSIDER,
      { tool: "submit", args: { summary: "Occupy alpha's candidate path" } },
      3,
    );
    expect(competingSubmit.result).toMatchObject({ status: "validated", tier: "auto" });
    await tick(worker, POOL);
    await waitFor(async () => (await landed()).some((landing) => landing.note.attempt?.id === OUTSIDER), 30_000);
    expect((await repair.seen).model).toBe(CANDIDATES[0]!.model);
    await waitFor(async () => {
      const card = await raceCard();
      return card.candidates?.[alpha]?.state === "going_around" && card.candidates[alpha]!.can_choose === false;
    });
    const afterRepair = await raceCard();
    expect(afterRepair.card_id).toBe(ready.card_id);
    expect(afterRepair.candidates?.[beta]?.can_choose).toBe(true);
    expect(afterRepair.candidates?.[gamma]?.can_choose).toBe(true);
    expect((await eventsOf(worker, POOL, "card.closed")).filter((event) => event.card_id === ready.card_id)).toEqual(
      [],
    );
    expect(await eventsOf(worker, POOL, "headsup.sent")).toContainEqual(
      expect.objectContaining({ attempt_id: alpha, result: "repair" }),
    );

    const invalidChoice = await worker.fetch(
      `/api/pools/${POOL}/cards/${ready.card_id}`,
      bearer({
        option: "choose",
        attempt_id: alpha,
        submit_ids: afterRepair.submit_ids,
        reason: "Unavailable candidate",
        request_id: "race-choose-unavailable",
      }),
    );
    expect(invalidChoice.status).toBe(400);
    expect(await invalidChoice.json()).toMatchObject({ error: { code: "invalid_args" } });
    expect(
      (await eventsOf(worker, POOL, "attempt.state")).filter(
        (event) => ids.includes(String(event.attempt_id)) && event.to === "stopped",
      ),
    ).toEqual([]);
    expect((await eventsOf(worker, POOL, "card.closed")).filter((event) => event.card_id === ready.card_id)).toEqual(
      [],
    );

    const choice = await worker.fetch(
      `/api/pools/${POOL}/cards/${ready.card_id}`,
      bearer({
        option: "choose",
        attempt_id: beta,
        submit_ids: (await raceCard()).submit_ids,
        reason: REASON,
        request_id: "race-choose-beta",
      }),
    );
    expect(choice.status, await choice.clone().text()).toBe(200);
    expect(await choice.json()).toEqual({ ok: true });
    await tick(worker, POOL);
    await waitFor(async () => (await landed()).some((landing) => landing.note.attempt?.id === beta), 30_000);

    const closures = (await eventsOf(worker, POOL, "card.closed")).filter((event) => event.card_id === ready.card_id);
    expect(closures).toHaveLength(1);
    const close = closures[0]!;
    // Strip only the stream envelope: the semantic payload carries the typed
    // reason as-is, with the chosen id in its own field (CD1).
    expect(
      Object.fromEntries(
        Object.entries(close).filter(([key]) => !["n", "t", "ts", "pool", "src", "type"].includes(key)),
      ),
    ).toEqual({
      card_id: ready.card_id,
      action: "choose",
      by: "owner",
      attempt_id: beta,
      reason: REASON,
    });
    const stopped = (await eventsOf(worker, POOL, "attempt.state")).filter(
      (event) => ids.includes(String(event.attempt_id)) && event.to === "stopped",
    );
    expect(stopped.map((event) => event.attempt_id).sort()).toEqual([alpha, gamma].sort());
    for (const event of stopped) expect(event).toMatchObject({ transition: "T14", reason: "not_chosen" });
    const chosen = (await landed()).find((landing) => landing.note.attempt?.id === beta)!;
    expect(chosen.note.attempt).toMatchObject({ id: beta, agent: "real", model: CANDIDATES[1]!.model });
    expect(chosen.note.policy).toMatchObject({ tier: "held", approved_by: "owner", option: "choose" });
    const directory = worker.repoDir(POOL);
    expect(git(directory, ["rev-parse", "refs/heads/main"])).toBe(chosen.commit);
    expect(git(directory, ["show", `main:${CANDIDATES[1]!.path}`])).toBe(CANDIDATES[1]!.content.trimEnd());
    expect(git(directory, ["show", `main:${CANDIDATES[0]!.path}`])).toBe('export const marker = "already-landed";');
    expect(git(directory, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).not.toContain(CANDIDATES[2]!.path);
    expect(git(directory, ["show", "-s", "--format=%an", chosen.commit])).toBe(CANDIDATES[1]!.model);
    expect(() => git(directory, ["fsck", "--strict"])).not.toThrow();
    expect(await eventsOf(worker, POOL, "trunk.error")).toEqual([]);
    expect(readFileSync(BUNDLE, "utf8")).toBe(originalBundle);
    // Attempt repository provisioning stays disabled in the production config;
    // this service acceptance establishes retained Agent data, not hosted repos.
    for (const attempt of [alpha, gamma]) expect((await inspect(attempt)).transcript.length).toBeGreaterThan(0);
  }, 240_000);
});
