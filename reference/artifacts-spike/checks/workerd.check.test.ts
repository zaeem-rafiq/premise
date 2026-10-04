/**
 * Optional check, not part of `npx vitest run`: the dry-run bundle (dist/index.js) on the
 * real Workers runtime (local workerd through the Miniflare API). Fully offline:
 *  - no wrangler dev, no Cloudflare account, no Artifacts service;
 *  - ARTIFACTS and AI are service bindings to a second local Worker whose RPC methods
 *    call back into a Node control server that wraps the fake binding from test/helpers
 *    (real bare git repos served by real git http-backend).
 *
 * It covers what only the runtime can show: the one-experiment-at-a-time lock across
 * overlapping calls into the Durable Object, cancellation at the deadline, the body size
 * limit, the User-Agent that fetch() sends from workerd, and that the outside-control token
 * stays in the Durable Object's memory between two requests (for the second inside probe).
 *
 * Run (it builds the bundle first):
 *   npm run check:workerd
 *
 * `miniflare` is a devDependency of this package, pinned to the version wrangler 4.147.0 uses.
 *
 * The setup part (fake Worker, control server) is taken from the independent checker's
 * .check/workerd.check.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeArtifacts } from "../test/helpers/fake-artifacts";
import { startGitServer, type GitServer } from "../test/helpers/git-http-server";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = join(ROOT, ".tmp-test");
mkdirSync(TMP, { recursive: true });
const KEY = "workerd-check-key-0123456789abcdef";

const FAKE_WORKER = `
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
async function call(env, target, method, args) {
  const res = await fetch(env.CONTROL + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, method, args }) });
  const out = await res.json();
  if (out.error) {
    const e = new Error(out.error.message);
    e.name = "ArtifactsError";
    e.code = out.error.code;
    e.numericCode = out.error.numericCode;
    throw e;
  }
  const v = out.value;
  if (v && typeof v === "object" && v.__blob) {
    const bin = Uint8Array.from(atob(v.base64), (c) => c.charCodeAt(0));
    return new Blob([bin], { type: v.type });
  }
  return v;
}
class Repo extends RpcTarget {
  #env; #name;
  constructor(env, name) { super(); this.#env = env; this.#name = name; }
  info() { return call(this.#env, this.#name, "info", []); }
  createToken(scope, ttl) { return call(this.#env, this.#name, "createToken", [scope, ttl]); }
  listTokens() { return call(this.#env, this.#name, "listTokens", []); }
  revokeToken(t) { return call(this.#env, this.#name, "revokeToken", [t]); }
  fork(name, opts) { return call(this.#env, this.#name, "fork", [name, opts]); }
  log(opts) { return call(this.#env, this.#name, "log", [opts]); }
  readCommit(h) { return call(this.#env, this.#name, "readCommit", [h]); }
  readTree(h) { return call(this.#env, this.#name, "readTree", [h]); }
  readBlob(h) { return call(this.#env, this.#name, "readBlob", [h]); }
  readFile(a) { return call(this.#env, this.#name, "readFile", [a]); }
}
export class ArtifactsEntrypoint extends WorkerEntrypoint {
  create(name, opts) { return call(this.env, "@ns", "create", [name, opts]); }
  async get(name) { await call(this.env, "@ns", "get", [name]); return new Repo(this.env, name); }
  list(opts) { return call(this.env, "@ns", "list", [opts]); }
  delete(name) { return call(this.env, "@ns", "delete", [name]); }
}
export class AiEntrypoint extends WorkerEntrypoint {
  run(model, input) { return { choices: [{ index: 0, message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] }; }
}
export default { fetch() { return new Response("fake"); } };
`;

let root: string;
let server: GitServer;
let control: Server;
let fake: FakeArtifacts;
let mf: Miniflare;
const rpcLog: string[] = [];

async function run(id: string, body: Record<string, unknown> = {}, key: string | null = KEY): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["x-spike-key"] = key;
  const res = await mf.dispatchFetch(`http://spike.local/run/${id}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { unparsable: text.slice(0, 2000) };
  }
  return { status: res.status, json };
}
function show(id: string, r: { status: number; json: any }): void {
  const j = r.json;
  console.log(`[workerd] ${id}: http ${r.status} ok=${j.ok} error=${j.error ?? ""}\n  verdict=${JSON.stringify(j.data?.verdict)}\n  timings=${JSON.stringify(j.timings_ms).slice(0, 500)}`);
  if (j.ok !== true) console.log(`  observations:\n   - ${(j.observations ?? []).join("\n   - ").slice(0, 4000)}`);
}

beforeAll(async () => {
  root = mkdtempSync(join(TMP, "workerd-"));
  fake = new FakeArtifacts(root, (repo) => server.remoteFor(repo), { createPendingGets: 1, forkPendingGets: 1 });
  server = await startGitServer({ root, authorize: fake.authorize });
  control = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const { target, method, args } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { target: string; method: string; args: unknown[] };
      rpcLog.push(`${target === "@ns" ? "ns" : "repo"}.${method}`);
      let payload: unknown;
      try {
        let value: unknown;
        if (target === "@ns") {
          if (method === "get") {
            const handle = await fake.get(args[0] as string);
            handle[Symbol.dispose]();
            value = true;
          } else {
            value = await (fake as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
          }
        } else {
          const record = fake.repos.get(target);
          if (!record) throw Object.assign(new Error(`repository ${target} not found`), { code: "NOT_FOUND", numericCode: 10200 });
          const saved = record.pendingGets;
          record.pendingGets = 0;
          const handle = await fake.get(target);
          record.pendingGets = saved;
          value = await (handle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
          handle[Symbol.dispose]();
        }
        if (value instanceof Blob) value = { __blob: true, base64: Buffer.from(await value.arrayBuffer()).toString("base64"), type: value.type };
        payload = { value: value === undefined ? null : value };
      } catch (e) {
        const err = e as { name?: string; code?: string; numericCode?: number; message?: string };
        payload = { error: { name: err.name, code: err.code, numericCode: err.numericCode, message: err.message ?? String(e) } };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    })().catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(e) } }));
    });
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlOrigin = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;

  mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: [
      {
        name: "artifacts-spike",
        modules: [{ type: "ESModule", path: join(ROOT, "dist/index.js") }],
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { SPIKE_KEY: KEY },
        durableObjects: { SPIKE_DO: { className: "SpikeDO", useSQLite: true } },
        serviceBindings: {
          ARTIFACTS: { name: "fake", entrypoint: "ArtifactsEntrypoint" },
          AI: { name: "fake", entrypoint: "AiEntrypoint" },
        },
      },
      {
        name: "fake",
        modules: [{ type: "ESModule", path: "fake.mjs", contents: FAKE_WORKER }],
        compatibilityDate: "2026-10-01",
        bindings: { CONTROL: controlOrigin },
      },
    ],
  }));
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  control?.closeAllConnections();
  await new Promise<void>((resolve) => control.close(() => resolve()));
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});


describe("fixes on real workerd (offline)", () => {
  it("one experiment at a time: a request during a soak is refused as busy, and accepted afterwards", async () => {
    const soak = run("e7-soak", { k: 40 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const early = await run("cleanup", { dry_run: true });
    console.log("[workerd] during the soak:", early.status, early.json.ok, early.json.error);
    expect(early.json.ok).toBe(false);
    expect(early.json.error).toMatch(/^busy: experiment "e7-soak"/);
    const done = await soak;
    console.log("[workerd] soak:", done.json.ok, JSON.stringify(done.json.data?.verdict));
    expect(done.json.ok).toBe(true);
    const late = await run("cleanup", { dry_run: true });
    console.log("[workerd] after the soak:", late.json.ok, late.json.error ?? "");
    expect(late.json.ok).toBe(true);
  });

  it("deadline: the run is cancelled, stops, and the next request is not refused", async () => {
    const r = await run("e7-soak", { k: 500, deadline_ms: 1000 });
    console.log("[workerd] deadline:", r.json.ok, r.json.error);
    expect(r.json.error).toMatch(/The experiment was cancelled and stopped \d+ ms later/);
    const before = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const late = server.requests.slice(before).filter((q) => q.receivedAt > Date.now() - 1000);
    console.log("[workerd] git requests that arrived in the last second:", late.length);
    expect(late).toEqual([]);
    const next = await run("cleanup", { dry_run: true });
    expect(next.json.ok).toBe(true);
  });

  it("a body over 16 KiB gets 413", async () => {
    const res = await mf.dispatchFetch("http://spike.local/run/e9-workers-ai", { method: "POST", headers: { "content-type": "application/json", "x-spike-key": KEY }, body: JSON.stringify({ models: Array.from({ length: 5000 }, (_, i) => `m${i}`), pad: "x".repeat(1024 * 1024) }) });
    const json = (await res.json()) as { ok: boolean; error: string };
    console.log("[workerd] big body:", res.status, json.error);
    expect(res.status).toBe(413);
  });

  it("e2 outside control: the token comes back only under disclosed, and the git User-Agent reaches the server", async () => {
    expect((await run("e1-create-push")).json.ok).toBe(true);
    const before = server.requests.length;
    const r = await run("e2-minted-token", { outside_control: true });
    show("e2+outside", r);
    expect(r.json.ok).toBe(true);
    const token = r.json.disclosed.token as string;
    expect(fake.issued).toContain(token);
    const { disclosed: _d, ...rest } = r.json;
    const text = JSON.stringify(rest);
    for (const t of fake.issued) expect(text.includes(t.split("?")[0]!)).toBe(false);
    const agents = server.requests.slice(before).map((q) => q.userAgent);
    console.log("[workerd] distinct User-Agent values the git server saw during e2:", JSON.stringify([...new Set(agents.map((a) => a ?? null))]), "inside:", JSON.stringify(r.json.data.outside_control.inside_durable_object));
    // Two GET info/refs and two POST probes carry git's User-Agent.
    expect(agents.filter((a) => a === "git/2.50.1")).toHaveLength(4);
    // Every other request from workerd carried no User-Agent header at all.
    expect(agents.filter((a) => a !== "git/2.50.1").every((a) => a === undefined)).toBe(true);
    const inside = r.json.data.outside_control.inside_durable_object as { request: string; status: number }[];
    expect(inside.map((p) => `${p.request}=${p.status}`)).toEqual(Array.from({ length: 4 }, () => ["GET info/refs=200", "POST git-upload-pack=200"]).flat());
  });

  it("e2 outside control recheck: a second request finds the same token in the Durable Object's memory, uses it once, and returns no token", async () => {
    const issued = fake.issued.length;
    const again = await run("e2-minted-token", { outside_control_recheck: true });
    show("e2 recheck", again);
    expect(again.json.ok).toBe(true);
    // No token was minted for the recheck: it used the one from the previous request.
    expect(fake.issued.length).toBe(issued);
    const recheck = again.json.data.outside_control_recheck as { token_expired_before_end: boolean; inside_durable_object: { request: string; status: number }[] };
    expect(recheck.token_expired_before_end).toBe(false);
    expect(recheck.inside_durable_object.map((p) => `${p.request}=${p.status}`)).toEqual(Array.from({ length: 4 }, () => ["GET info/refs=200", "POST git-upload-pack=200"]).flat());
    expect(again.json.disclosed).toBeUndefined();
    for (const t of fake.issued) expect(JSON.stringify(again.json).includes(t.split("?")[0]!)).toBe(false);
    // The token was dropped after that one use.
    const third = await run("e2-minted-token", { outside_control_recheck: true });
    expect(third.json.ok).toBe(false);
    expect(third.json.data.verdict.outside_control_recheck).toMatch(/^not run: no outside-control token is held in memory/);
  });
});
