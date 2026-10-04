/**
 * Smoke test of the exact bundle `wrangler deploy` would upload.
 *
 * It builds the bundle with `wrangler deploy --dry-run` (nothing is uploaded),
 * imports it under Node with `cloudflare:workers` replaced by a stub, and
 * drives it through its real entry point: fetch handler -> Durable Object
 * class -> experiments -> fake Artifacts binding -> real git over HTTP.
 *
 * This checks that the bundled code (isomorphic-git's ESM build, the
 * in-memory filesystem, the raw pack code) works as a unit. It runs on Node,
 * not on the Workers runtime, so runtime differences are not covered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExperimentResult } from "../src/recorder";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { makeTempDir, removeDir, startGitServer, type GitServer } from "./helpers/git-http-server";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "bundle-test-key-0123456789abcdef";

interface WorkerModule {
  default: { fetch(request: Request, env: unknown): Promise<Response> };
  SpikeDO: new (ctx: unknown, env: unknown) => { run(id: string, body: Record<string, unknown>, meta: Record<string, unknown>): Promise<ExperimentResult> };
}

let outDir: string;
let root: string;
let server: GitServer;
let fake: FakeArtifacts;
let worker: WorkerModule;
let env: Record<string, unknown>;
const storage = new Map<string, unknown>();
let instances = 0;

async function call(path: string, init: { method?: string; key?: string | null; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.key !== null) headers.set("x-spike-key", init.key ?? KEY);
  const response = await worker.default.fetch(
    new Request(`https://artifacts-spike.example.workers.dev${path}`, { method: init.method ?? "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    env,
  );
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  outDir = makeTempDir("bundle");
  // Bundle only. --dry-run never contacts Cloudflare.
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outDir], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker = (await import(/* @vite-ignore */ pathToFileURL(join(outDir, "index.js")).href)) as WorkerModule;

  root = makeTempDir("bundle-repos");
  fake = new FakeArtifacts(root, (repo) => server.remoteFor(repo), { createPendingGets: 1, forkPendingGets: 1 });
  server = await startGitServer({ root, authorize: fake.authorize });

  let instance: InstanceType<WorkerModule["SpikeDO"]> | undefined;
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
      delete: async (key: string) => storage.delete(key),
    },
  };
  env = {
    SPIKE_KEY: KEY,
    ARTIFACTS: fake,
    AI: { run: async () => ({ choices: [{ index: 0, message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] }) },
    SPIKE_DO: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        expect(id).toBe("spike");
        if (!instance) {
          instances++;
          instance = new worker.SpikeDO(ctx, env);
        }
        return instance;
      },
    },
  };
});

afterAll(async () => {
  await server?.close();
  if (root) removeDir(root);
  if (outDir) removeDir(outDir);
});

describe("the bundle wrangler would upload", () => {
  it("was built, and imports only cloudflare:workers and Node built-ins", () => {
    const bundlePath = join(outDir, "index.js");
    expect(existsSync(bundlePath)).toBe(true);
    const source = readFileSync(bundlePath, "utf8");
    const imported = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]!).sort();
    expect(imported.length).toBeGreaterThan(0);
    for (const specifier of imported) expect(specifier).toMatch(/^(cloudflare:workers|node:[a-z_/]+|buffer)$/);
    expect(imported).toContain("cloudflare:workers");
    expect(source).not.toMatch(/\brequire\("(?!node:)/);
    expect(typeof worker.default.fetch).toBe("function");
    expect(typeof worker.SpikeDO).toBe("function");
  });

  it("refuses every request without the key, and when the secret is missing", async () => {
    expect((await call("/run/e1-create-push", { key: null })).status).toBe(401);
    expect((await call("/run/cleanup", { key: "wrong" })).status).toBe(401);
    expect((await call("/", { method: "GET", key: null })).status).toBe(401);
    const response = await worker.default.fetch(new Request("https://x.example/run/e1-create-push", { method: "POST", headers: { "x-spike-key": KEY } }), { ...env, SPIKE_KEY: undefined });
    expect(response.status).toBe(503);
    expect(fake.repos.size).toBe(0);
    expect(instances).toBe(0);
  });

  it("lists the experiments", async () => {
    const { status, json } = await call("/", { method: "GET" });
    expect(status).toBe(200);
    expect(json.experiments).toHaveLength(10);
  });

  it("runs e1 to e8 through fetch -> Durable Object -> isomorphic-git / raw pack -> real git", async () => {
    const bodies: [string, Record<string, unknown>][] = [
      ["e1-create-push", {}],
      ["e2-minted-token", {}],
      ["e3-compare-and-swap", {}],
      ["e4-refs", {}],
      ["e5-fork", { n: 2 }],
      ["e6-read-by-ref", { reps: 1, rounds: 1 }],
      ["e7-soak", { k: 3 }],
      ["e8-raw-pack", {}],
    ];
    for (const [id, body] of bodies) {
      const { status, json } = await call(`/run/${id}`, { body });
      const result = json as ExperimentResult;
      expect(status, id).toBe(200);
      expect(result.experiment).toBe(id);
      expect(result.ok, `${id}: ${result.error ?? ""}\n${result.observations.join("\n")}`).toBe(true);
      expect((result.data!.env as Record<string, unknown>).ran_in).toBe("Durable Object SpikeDO");
      const text = JSON.stringify(result);
      for (const token of fake.issued) expect(text.includes(token.split("?")[0]!), `${id} leaks a token`).toBe(false);
    }
    // One Durable Object instance served every call, and its storage holds the e1 state.
    expect(instances).toBe(1);
    expect(storage.has("e1")).toBe(true);
  });

  it("e3 and e8 verdicts from the bundle match real git", async () => {
    const e3 = (await call("/run/e3-compare-and-swap")).json as ExperimentResult;
    expect(e3.data!.verdict).toMatchObject({ server_enforces_old_id: true, isogit_stale_push_rejected_by: "client (no POST sent)", force_push_allowed: true, branch_delete_allowed: true });
    const e8 = (await call("/run/e8-raw-pack")).json as ExperimentResult;
    expect(e8.data!.verdict).toMatchObject({ single_ref_push: true, wrong_old_id_rejected: true, one_bad_command_fails_both_with_atomic: true });
  });

  it("cleanup through the bundle deletes the spike repos and the stored e1 state", async () => {
    expect(fake.repos.size).toBeGreaterThan(0);
    const { status, json } = await call("/run/cleanup");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(fake.repos.size).toBe(0);
    expect(storage.has("e1")).toBe(false);
  });
});
