// 09-try in local workerd: `POST /api/try` with no owner key creates a `try-<id>` pool from seed
// `tidepool` and the try conductor's Workflow plays TY8's rows in it — J lands by itself, S's held
// card is tapped Land, C and H get their repair heads-ups, go around and land — with an `AI`
// stand-in that records every call, and none may come (TY5). Then the limits (TY6, TY6a), the kill
// switch (TY7) and the switch (TY1).
//
// Expected values come from the specification: the patterns' intents and the hero scene's final
// files (02-tidepool 7: `ENERGY_MAX = 1`, `crab.energy < 0.3`, `drain(shrimp, 0.05)`), the copy
// table of 03-floor 5.4 and TY2's answers.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { waitFor } from "../trunk/harness.ts";
import { KEY } from "../collide/helpers.ts";
import { patternById } from "../../../src/swarm/pattern.ts";
import { text } from "../../../src/copy/strings.ts";

type Ev = Record<string, unknown>;

/** The `AI` binding's upstream: every call is recorded and refused. A try must make none. */
async function startModelTrap(): Promise<{ url: string; calls: () => number; close(): Promise<void> }> {
  let calls = 0;
  const server: Server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(500, { "content-type": "application/json" }).end('{"error":"a try called a model"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function tryPost(worker: LandingWorker, address: string): Promise<Response> {
  return worker.fetch("/api/try", { method: "POST", headers: { "cf-connecting-ip": address } });
}

/** The attempt id of each canned pattern, from the stream: the intent's text is the pattern's. */
function attemptsByPattern(events: Ev[]): Map<string, string> {
  const intents = new Map<string, string>(); // intent text -> intent id
  for (const e of events) if (e.type === "intent.created") intents.set(String(e.text), String(e.intent_id));
  const out = new Map<string, string>();
  for (const id of ["hero-s", "hero-c", "hero-h", "hero-j"]) {
    const intentId = intents.get(patternById(id)!.intent);
    const opened = events.find((e) => e.type === "attempt.opened" && e.intent_id === intentId);
    if (opened !== undefined) out.set(id, String(opened.attempt_id));
  }
  return out;
}

/** `landing.landed` index (stream position) per attempt, through `landing.accepted`'s seq. */
function landedAt(events: Ev[], attempt: string): number {
  const accepted = events.find((e) => e.type === "landing.accepted" && e.attempt_id === attempt);
  if (accepted === undefined) return -1;
  return events.findIndex((e) => e.type === "landing.landed" && e.seq === accepted.seq);
}

describe("09-try: a visitor's try in local workerd", () => {
  let worker: LandingWorker;
  let trap: Awaited<ReturnType<typeof startModelTrap>>;
  let pool = "";

  beforeAll(async () => {
    trap = await startModelTrap();
    worker = await startLandingWorker({
      ownerKey: KEY,
      features: { try: true },
      swarm: true,
      tryWorkflow: true,
      autoCreateRepos: true,
      repos: [],
      modelUrl: trap.url,
      // As deployed: Clef triage on. A synthetic attempt takes the scripted triage (TR8).
      vars: { CLEF_TRIAGE: "on" },
    });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
    await trap?.close();
  });

  it("TY2 TY3 TY4 TY5 TY8: a try pool plays the crab conflict to the crab's landing after a go-around, with no model call", async () => {
    const response = await tryPost(worker, "203.0.113.7");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { pool: string; path: string };
    expect(body.pool).toMatch(/^try-[a-z0-9]{10}$/);
    expect(body.path).toBe(`/p/${body.pool}`);
    pool = body.pool;

    await waitFor(
      async () => (await worker.eventTypes(pool)).filter((t) => t === "landing.landed").length >= 4,
      200_000,
    );
    const events = await worker.events(pool);
    const attempts = attemptsByPattern(events);
    expect([...attempts.keys()].sort()).toEqual(["hero-c", "hero-h", "hero-j", "hero-s"]);

    // TY4: an ordinary pool, not summary-only, whose attempts are synthetic (EM1a).
    const states = events.filter((e) => e.type === "pool.state");
    expect(states.every((e) => e.summary_only === false)).toBe(true);
    expect(states.some((e) => e.synthetic === true)).toBe(true);
    expect(events.filter((e) => e.type === "attempt.opened").every((e) => e.agent === "synthetic")).toBe(true);

    // TY8 row 1: J lands by itself, first, and never gets a heads-up.
    const j = attempts.get("hero-j")!;
    const s = attempts.get("hero-s")!;
    const c = attempts.get("hero-c")!;
    const h = attempts.get("hero-h")!;
    expect(landedAt(events, j)).toBeGreaterThanOrEqual(0);
    expect(landedAt(events, j)).toBeLessThan(landedAt(events, s));
    expect(events.filter((e) => e.type === "headsup.sent" && e.attempt_id === j)).toEqual([]);

    // TY8 rows 3-4: S lands on the tap; the crab and the shrimp get their repair heads-ups when
    // S's landing is accepted (01-core: the heads-up goes out at acceptance), go around, and land
    // after them.
    const sAccepted = events.findIndex((e) => e.type === "landing.accepted" && e.attempt_id === s);
    for (const creature of [c, h]) {
      const heads = events.findIndex(
        (e) => e.type === "headsup.sent" && e.attempt_id === creature && e.result === "repair",
      );
      expect(heads, `repair heads-up to ${creature}`).toBeGreaterThan(sAccepted);
      expect(landedAt(events, creature)).toBeGreaterThan(heads);
    }
    const cardTaps = events.filter((e) => e.type === "card.closed" && e.action === "land");
    expect(cardTaps.length).toBeGreaterThanOrEqual(1);

    // The adapted files on the pool's remote (02-tidepool 7).
    const dir = worker.repoDir(pool);
    expect(git(dir, ["show", "main:world/energy.js"])).toContain("ENERGY_MAX = 1;");
    expect(git(dir, ["show", "main:creatures/crab.js"])).toContain("crab.energy < 0.3");
    expect(git(dir, ["show", "main:creatures/shrimp.js"])).toContain("drain(shrimp, 0.05)");

    // TY9: the conductor completed its rows.
    await waitFor(async () => (await worker.tryInstance(pool)).status === "complete", 60_000);
    expect((await worker.tryInstance(pool)).output).toBe("done");

    // TY5: the `AI` stand-in was never called.
    expect(trap.calls()).toBe(0);
  }, 300_000);

  it("TY6: a second try from the same client address within 600 s answers 429 with try.limited.address", async () => {
    const response = await tryPost(worker, "203.0.113.7");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: { code: "try_limited", message: text("try.limited.address") },
    });
  });

  it("TY6 TY6a: the hourly limit is durable in the gate, and the gate keeps no address", async () => {
    // One try is recorded (the first test). Nineteen more reach TRY_PER_HOUR = 20.
    const gate = worker.object("GATE", "premise");
    for (let i = 0; i < 19; i += 1) {
      const answer = await gate.fetch("/internal/try-record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: `198.51.100.${i}` }),
      });
      expect(await answer.json()).toEqual({ ok: true });
    }
    const response = await tryPost(worker, "192.0.2.55");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { code: "try_limited", message: text("try.limited.hour") } });

    // TY6a: no address in the gate's state or in the try pool's stream.
    const state = JSON.stringify(await gate.state());
    expect(state).not.toContain("203.0.113.7");
    expect(state).not.toContain("198.51.100.");
    expect(JSON.stringify(await worker.events(pool))).not.toContain("203.0.113.7");
  });

  it("TY2 TY7: while the kill switch is on, a try answers 403 with try.killed", async () => {
    const kill = await worker.fetch("/api/kill", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ killed: true }),
    });
    expect(kill.status).toBe(200);
    const response = await tryPost(worker, "192.0.2.99");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "killed", message: text("try.killed") } });
  });
});

describe("TY1: with features.try off", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, features: { try: false }, tryWorkflow: true, repos: [] });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("TY1: `POST /api/try` answers 404 feature_off with try.off", async () => {
    const response = await tryPost(worker, "203.0.113.8");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "feature_off", message: text("try.off") } });
  });
});
