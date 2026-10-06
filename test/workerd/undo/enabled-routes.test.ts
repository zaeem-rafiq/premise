// This fixture sets FEATURES.undo to true in the bundle's in-memory module contents
// (`withFeatures`), whatever the build ships, then runs its actual public
// route handlers against a recording local Trunk stand-in. No source, config,
// or bundle file is written, and the fake does not prove engine behavior.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { UndoPlan } from "../../../src/protocol/undo.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { bearer, KEY } from "../collide/helpers.ts";
import { withFeatures } from "../../support/features.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const ORIGIN = "http://premise.test";
const POOL = "enabled-undo-routes";
const PLAN_PATH = `/api/pools/${POOL}/undo-plan`;
const UNDO_PATH = `/api/pools/${POOL}/undo`;
const PLAN: UndoPlan = {
  target_seq: 1,
  reverted: [1, 4],
  reopened: ["crab"],
  kept_readers: [3],
  repairs: ["shrimp"],
};

const FAKE_TRUNK = `
import { DurableObject } from "cloudflare:workers";
export class RecordingTrunk extends DurableObject {
  calls = [];
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/reset") {
      this.calls = [];
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/state") return Response.json({ calls: this.calls });
    const body = request.method === "GET" ? null : await request.json();
    this.calls.push({ pool: this.ctx.id.name, method: request.method, url: request.url, body });
    const plan = ${JSON.stringify(PLAN)};
    if (request.method === "GET") return Response.json({ ok: true, plan });
    if (body.request_id === "changed") return Response.json({ ok: false, reason: "plan_changed", plan });
    return Response.json({ ok: true, request_id: body.request_id });
  }
}
export default { fetch: () => new Response("local recording Trunk only", { status: 404 }) };
`;

type RecordedCall = { pool: string; method: string; url: string; body: unknown };
type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };

describe("enabled undo public handlers with an in-memory feature fixture", () => {
  let worker: Miniflare;
  let trunk: Stub;
  let original: string;

  beforeAll(async () => {
    original = readFileSync(BUNDLE, "utf8");
    worker = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "premise",
            modules: [{ type: "ESModule", path: BUNDLE, contents: withFeatures(original, { undo: true }) }],
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { OWNER_KEY: KEY },
            durableObjects: { TRUNK: { className: "RecordingTrunk", scriptName: "recording-trunk" } },
          },
          {
            name: "recording-trunk",
            modules: [
              { type: "ESModule", path: join(REPO_ROOT, ".tmp-test/undo-recording-trunk.mjs"), contents: FAKE_TRUNK },
            ],
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: { RecordingTrunk: { className: "RecordingTrunk", useSQLite: true } },
          },
        ],
      }),
    );
    await worker.ready;
    const namespace = (await worker.getDurableObjectNamespace("TRUNK")) as unknown as Namespace;
    trunk = namespace.get(namespace.idFromName(POOL));
  }, 60_000);

  beforeEach(async () => {
    await trunk.fetch(`${ORIGIN}/internal/reset`, { method: "POST" });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  async function calls(): Promise<RecordedCall[]> {
    const response = await trunk.fetch(`${ORIGIN}/internal/state`);
    return ((await response.json()) as { calls: RecordedCall[] }).calls;
  }

  function fetch(path: string, init?: RequestInit): Promise<Response> {
    return worker.dispatchFetch(`${ORIGIN}${path}`, init as never);
  }

  it("UN4: a valid seq is forwarded as the Trunk q envelope and UndoPlanResponse is preserved", async () => {
    const response = await fetch(`${PLAN_PATH}?seq=1&unrelated=discard`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, plan: PLAN });
    const recorded = await calls();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ pool: POOL, method: "GET", body: null });
    const url = new URL(recorded[0]!.url);
    expect(url.pathname).toBe(PLAN_PATH);
    expect([...url.searchParams]).toEqual([["q", JSON.stringify({ seq: 1 })]]);
  });

  it("UN4: missing, noninteger, nonpositive and unsafe seq values never reach Trunk", async () => {
    for (const seq of [undefined, "", "0", "-1", "1.5", "1e2", "01", "Infinity", "9007199254740992", "wrong"]) {
      const response = await fetch(`${PLAN_PATH}${seq === undefined ? "" : `?seq=${encodeURIComponent(seq)}`}`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(response.status, String(seq)).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_args" } });
    }
    expect(await calls()).toEqual([]);
  });

  it("UN5: confirmation forwards seq, expect_reverted and request_id and preserves UndoResponse", async () => {
    const request = { seq: 1, expect_reverted: [1, 4], request_id: "confirmed" };
    const response = await fetch(UNDO_PATH, bearer(request));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, request_id: "confirmed" });
    expect(await calls()).toEqual([{ pool: POOL, method: "POST", url: `${ORIGIN}${UNDO_PATH}`, body: request }]);
  });

  it("UN5/C53: plan_changed and its replacement plan pass through unchanged", async () => {
    const response = await fetch(UNDO_PATH, bearer({ seq: 1, expect_reverted: [1], request_id: "changed" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: "plan_changed", plan: PLAN });
    expect(await calls()).toHaveLength(1);
  });

  it("UN5: malformed confirmations and missing required fields never reach Trunk", async () => {
    const valid = { seq: 1, expect_reverted: [1, 4], request_id: "valid" };
    const invalid: unknown[] = [
      null,
      [],
      "wrong",
      {},
      { expect_reverted: [1], request_id: "missing-seq" },
      { seq: 1, request_id: "missing-plan" },
      { seq: 1, expect_reverted: [1] },
      ...["1", null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((seq) => ({ ...valid, seq })),
      ...[null, 1, "1", ["1"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]].map((expect_reverted) => ({
        ...valid,
        expect_reverted,
      })),
      ...["", null, 1].map((request_id) => ({ ...valid, request_id })),
    ];
    for (const body of invalid) {
      const response = await fetch(UNDO_PATH, bearer(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_args" } });
    }
    const malformed = await fetch(UNDO_PATH, { ...bearer({}), body: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "invalid_args" } });
    expect(await calls()).toEqual([]);
  });

  it("SE2: enabled undo handlers still require the owner credential", async () => {
    const plan = await fetch(`${PLAN_PATH}?seq=1`);
    expect(plan.status).toBe(401);
    const undo = await fetch(UNDO_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1, expect_reverted: [1, 4], request_id: "unauthorized" }),
    });
    expect(undo.status).toBe(401);
    expect(await calls()).toEqual([]);
  });

  it("the enabled fixture leaves the built bundle unchanged on disk", () => {
    expect(readFileSync(BUNDLE, "utf8")).toBe(original);
  });
});
