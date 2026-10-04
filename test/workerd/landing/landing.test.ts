// test/workerd/landing/landing.test.ts — the Slice-1 acceptance of docs/spec/04-build-plan.md 2.2
// in local workerd: one scripted change travels the whole architecture — pool creation, the
// Swarm launch, the Agent DO, the Trunk engine, the event stream, the Floor reducer, the local
// `git http-backend` remote (standing in for Artifacts) and the pool app server.
//
//   item 1/2  the stream: pool.state, pool.files, then the launch's ordered sequence down to
//             landing.landed — with refs/heads/main at that commit the moment it is appended
//   item 3    the commit: Change-Id and Intent-Id trailers only, author "SYNTHETIC swarm", the
//             premise note hashing to landing.landed.note, `git fsck --strict` clean
//   item 5    the app server: SE14 headers, immutable `v/c-<commit>` files, .premise 404, and no
//             request to Trunk (the DO's `served` log)
//   item 6    401 without the key; one request_id creates one pool
//   item 4    a browser check — the lead's; the events and routes it needs exist here

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { git, gitBytes } from "../../git/helpers.ts";
import { waitFor } from "../trunk/harness.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const POOL = "it-tracer";
const SEED = "tidepool-swarm";
const TOKEN = `tok-${POOL}-write`;

function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

describe("the Slice-1 landing in local workerd (04-build-plan 2.2)", () => {
  let worker: LandingWorker;
  /** The landing.landed event's commit, found when the stream completes. */
  let landed: { commit: string; note: string; seq: number } | null = null;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL], expectedToken: TOKEN });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("items 1 and 2: creation's first two events, then the launch's ordered stream to landing.landed", async () => {
    const unauth = await worker.fetch("/api/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: "x", seed: SEED, request_id: "r-x" }),
    });
    expect(unauth.status, "item 6: a mutating request without the key answers 401").toBe(401);

    const res = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, seed: SEED, summary_only: false, request_id: "r-it-tracer" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: POOL });

    // The seed's batch pushes through the local remote (PL1): the stream's first events.
    await waitFor(async () => (await worker.eventTypes(POOL)).length >= 3, 30_000);
    const created = await worker.events(POOL);
    expect(created[0]?.type).toBe("pool.state");
    expect(created[0]).toMatchObject({ head_seq: 0, synthetic: false, summary_only: false });
    expect(created[1]?.type).toBe("pool.files");
    // main is the seed commit on the remote before any agent runs.
    const seedMain = git(worker.repoDir(POOL), ["rev-parse", "refs/heads/main"]);
    expect(created[0]?.head_commit).toBe(seedMain);

    // One add-plain agent (SWR2).
    const swarm = await worker.fetch(
      "/api/swarm",
      bearer({
        seed: 7,
        agents: 1,
        launch_per_second: 1,
        collision_dial: 0,
        think_ms: [10, 20],
        rescale_every_s: 60,
        pool: POOL,
        running: true,
        patterns: ["add-plain"],
        request_id: "r-launch",
      }),
    );
    expect(swarm.status).toBe(200);
    const answer = (await swarm.json()) as { launched: string[] };
    expect(answer.launched).toHaveLength(1);

    // The ordered stream to landing.landed (item 2's exact sequence).
    await waitFor(async () => (await worker.eventTypes(POOL)).includes("landing.landed"), 60_000);
    const types = await worker.eventTypes(POOL);
    const order = [
      "pool.state",
      "attempt.opened",
      "submit.result",
      "landing.accepted",
      "batch.pushed",
      "landing.landed",
    ];
    let at = 0;
    const seen: string[] = [];
    for (const type of types) {
      if (type === order[at]) {
        seen.push(type);
        at += 1;
      }
    }
    expect(seen, `stream ${types.join(",")}`).toEqual(order);
    // The synthetic pool.state (EM1a) precedes attempt.opened.
    const syntheticIndex = (await worker.events(POOL)).findIndex(
      (event) => event.type === "pool.state" && event.synthetic === true,
    );
    expect(syntheticIndex).toBeGreaterThan(-1);
    expect(syntheticIndex).toBeLessThan(types.indexOf("attempt.opened"));

    const events = await worker.events(POOL);
    const landing = events.filter((e) => e.type === "landing.landed")[0] as {
      commit: string;
      note: string;
      seq: number;
    };
    landed = landing;
    // Item 2's tail: at the moment landing.landed is appended, the remote's main is that commit.
    expect(git(worker.repoDir(POOL), ["rev-parse", "refs/heads/main"])).toBe(landing.commit);
  }, 90_000);

  it("item 3: the landing commit's trailers, author, premise note and fsck (stock git)", () => {
    expect(landed, "the landing test ran first").not.toBeNull();
    const dir = worker.repoDir(POOL);

    // Exactly a Change-Id and an Intent-Id trailer, in that order, and nothing else.
    const body = git(dir, ["log", "-1", "--format=%B", landed!.commit]);
    const trailers = git(dir, ["interpret-trailers", "--parse"], body)
      .split("\n")
      .filter((line) => line !== "");
    expect(trailers.map((line) => line.split(":")[0])).toEqual(["Change-Id", "Intent-Id"]);

    const author = git(dir, ["show", "-s", "--format=%an", landed!.commit]);
    expect(author).toBe("SYNTHETIC swarm");

    // `git notes --ref=premise show HEAD` — JSON with "seq":1 whose hash-object is the note oid.
    // The note blob ends in one LF (NT1), so the exact bytes of the pipe `show | hash-object`
    // are what hash — a text result's stripped newline would hash a different blob.
    const shown = gitBytes(dir, ["notes", "--ref=premise", "show", landed!.commit]);
    expect(JSON.parse(shown.toString("utf8"))).toMatchObject({ seq: 1 });
    const noteOid = git(dir, ["hash-object", "--stdin"], shown);
    expect(noteOid).toBe(landed!.note);

    expect(() => git(dir, ["fsck", "--strict"])).not.toThrow();
  });

  it("item 5: the app server — SE14 headers, immutable versions, .premise 404, no Trunk request", async () => {
    expect(landed).not.toBeNull();
    const before = (await worker.trunk(POOL).state()) as { served: Record<string, number> };

    const page = await worker.fetch(`/pool/${POOL}/main/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const file = await worker.fetch(`/pool/${POOL}/v/c-${landed!.commit}/world/energy.js`);
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toContain("immutable");

    const policy = await worker.fetch(`/pool/${POOL}/v/c-${landed!.commit}/.premise/policy.json`);
    expect(policy.status).toBe(404);

    // AS16: the reads above took nothing from Trunk — its served log did not move.
    const after = (await worker.trunk(POOL).state()) as { served: Record<string, number> };
    expect(after.served ?? {}).toEqual(before.served ?? {});
  }, 30_000);

  it("item 6: one request_id creates one pool", async () => {
    const again = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, seed: SEED, summary_only: false, request_id: "r-it-tracer" }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true });
    const states = (await worker.events(POOL)).filter((event) => event.type === "pool.state");
    // The create's pool.state — head_seq 0 before the synthetic flag flips at the launch (EM1a)
    // — is still the only one of its kind; the duplicate emitted none.
    expect(states.filter((event) => event.head_seq === 0 && event.synthetic === false)).toHaveLength(1);
  });
});
