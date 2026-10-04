// The Swarm launcher in local workerd (the `workerd` check of track 1J): the real built Worker
// bundle answers `POST /api/swarm`, with the `AGENT` Durable Object namespace bound to a fake
// worker that records what each named object is opened with. `npm run test:integration` runs this
// file; it needs `dist/worker/index.js` (`npm run build` writes it) and no deployment.
//
// A `durableObjects` entry with `scriptName` binds the namespace to a class of another worker, so
// the real route code drives a recording `FakeAgent` instead of the Slice-0 `Agent` stub.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT_INDEX = join(REPO_ROOT, "dist/client/index.html");

const OWNER_KEY = "test-owner-key";
const TRUTH = ["entity:world/bounds.js#bounce", "entity:world/movement.js#step", "entity:world/movement.js#wander"];

/** The fake Agent worker: every named `FakeAgent` Durable Object stores its `/open` payloads and
 * answers `already: true` when the same assignment arrives again (the idempotent open of 9.8). */
const FAKE_AGENT_SOURCE = `
import { DurableObject } from "cloudflare:workers";
export class FakeAgent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/open") {
      const body = await request.json();
      const seen = (await this.ctx.storage.get("opens")) ?? [];
      const already = seen.some((o) => JSON.stringify(o) === JSON.stringify(body));
      if (!already) seen.push(body);
      await this.ctx.storage.put("opens", seen);
      return Response.json({ ok: true, attempt_id: body.attempt_id, already });
    }
    if (url.pathname === "/records") {
      return Response.json({ opens: (await this.ctx.storage.get("opens")) ?? [] });
    }
    return new Response("not found", { status: 404 });
  }
}
`;

type RecordedOpen = {
  pool: string;
  attempt_id: string;
  driver: string;
  pattern: string;
  seed: number;
  agent_n: number;
  truth: string[];
  hold: boolean;
};

type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string): Promise<Response> };
};

let miniflare: Miniflare;

async function recordsOf(name: string): Promise<RecordedOpen[]> {
  const namespace = (await miniflare.getDurableObjectNamespace("AGENT", "fake-agent")) as unknown as Namespace;
  const response = await namespace.get(namespace.idFromName(name)).fetch("http://agent/records");
  return ((await response.json()) as { opens: RecordedOpen[] }).opens;
}

function swarmPost(body: Record<string, unknown>): Promise<Response> {
  return miniflare.dispatchFetch("http://premise.test/api/swarm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OWNER_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

const CONFIG = {
  seed: 7,
  agents: 2,
  launch_per_second: 1,
  collision_dial: 0,
  think_ms: [10, 20],
  rescale_every_s: 60,
};

beforeAll(async () => {
  if (!existsSync(BUNDLE) || !existsSync(CLIENT_INDEX)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { OWNER_KEY },
          durableObjects: {
            TRUNK: { className: "Trunk", useSQLite: true },
            AGENT: { className: "FakeAgent", scriptName: "fake-agent", useSQLite: true },
            FLOOR: { className: "Floor", useSQLite: true },
            GATE: { className: "ModelGate", useSQLite: true },
          },
          assets: {
            directory: join(REPO_ROOT, "dist/client"),
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        {
          name: "fake-agent",
          modules: [{ type: "ESModule", path: "fake-agent.mjs", contents: FAKE_AGENT_SOURCE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { AGENT: { className: "FakeAgent", useSQLite: true } },
        },
      ],
    }),
  );
  await miniflare.ready;
}, 120_000);

afterAll(async () => {
  await miniflare.dispose();
});

describe("POST /api/swarm in workerd with a fake Agent namespace (SWR1, SWR2, SWR4)", () => {
  it("SWR2: starts one scripted Agent Durable Object per entry of patterns, in list order", async () => {
    const response = await swarmPost({
      ...CONFIG,
      pool: "it-tracer",
      running: true,
      patterns: ["add-plain", "add-plain"],
      request_id: "workerd-order",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { launched: string[] };
    // Two launches, in list order, each a fresh attempt name (SWR2). The names the route returns
    // are the Durable Object names the records are read back through.
    expect(body.launched).toHaveLength(2);
    for (const name of body.launched) expect(name).toMatch(/^a_/);
    expect(body.launched[0]).not.toBe(body.launched[1]);
    const firstName = body.launched[0] as string;
    const secondName = body.launched[1] as string;
    const first = await recordsOf(firstName);
    const second = await recordsOf(secondName);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect((first[0] as RecordedOpen).agent_n).toBe(0);
    expect((second[0] as RecordedOpen).agent_n).toBe(1);
    expect((first[0] as RecordedOpen).driver).toBe("scripted");
    expect((second[0] as RecordedOpen).driver).toBe("scripted");
  });

  it("TR8: each agent is opened with its truth list", async () => {
    const response = await swarmPost({
      ...CONFIG,
      pool: "it-tracer",
      running: true,
      patterns: ["add-plain"],
      request_id: "workerd-truth",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { launched: string[] };
    const opens = await recordsOf(body.launched[0] as string);
    // The truth list of add-plain's row of 02-tidepool.md 10.3.
    expect((opens[0] as RecordedOpen).truth).toEqual(TRUTH);
  });

  it("SWR4: a repeated request_id launches nothing", async () => {
    const request = {
      ...CONFIG,
      pool: "it-tracer",
      running: true,
      patterns: ["add-plain", "add-plain"],
      request_id: "workerd-repeat",
    };
    const first = await swarmPost(request);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { launched: string[] };
    expect(firstBody.launched).toHaveLength(2);

    const second = await swarmPost(request);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { launched: string[] };
    expect(secondBody.launched).toEqual([]);

    for (const name of firstBody.launched) {
      expect(await recordsOf(name)).toHaveLength(1);
    }
  });
});
