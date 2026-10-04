/**
 * 1. The Worker's request handler (src/router.ts): fail-closed auth on every
 *    route, and a JSON answer for every outcome.
 * 2. run-spikes.sh end to end: the real script, driving the real request
 *    handler and the real experiment code over HTTP on localhost (fake
 *    Artifacts binding, real git). Checks the saved files, the one-line
 *    summaries, and that the key is never printed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPERIMENT_IDS, runExperiment, type Deps } from "../src/experiments";
import type { ExperimentResult } from "../src/recorder";
import { MAX_BODY_BYTES, handleRequest, type RouterDeps } from "../src/router";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { git, makeTempDir, removeDir, startGitServer, type GitServer } from "./helpers/git-http-server";

const KEY = "test-key-0123456789abcdef-0123456789abcdef";
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function routerDeps(overrides: Partial<RouterDeps> = {}): RouterDeps & { calls: { id: string; body: Record<string, unknown> }[] } {
  const calls: { id: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    spikeKey: KEY,
    experimentIds: EXPERIMENT_IDS,
    run: async (id, body) => {
      calls.push({ id, body });
      return { experiment: id, ok: true, observations: ["ran"], timings_ms: {}, http: [] };
    },
    ...overrides,
  };
}

function request(path: string, init: { method?: string; key?: string | null; body?: string } = {}): Request {
  const headers = new Headers();
  if (init.key !== null) headers.set("x-spike-key", init.key ?? KEY);
  return new Request(`https://spike.example${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

describe("handleRequest: fail-closed auth", () => {
  const paths: [string, string][] = [
    ["GET", "/"],
    ["POST", "/run/e1-create-push"],
    ["POST", "/run/cleanup"],
    ["POST", "/run/e9-workers-ai"],
    ["GET", "/anything/else"],
    ["DELETE", "/run/e1-create-push"],
  ];

  it("answers 401 on every route without the key or with a wrong key, and runs nothing", async () => {
    const deps = routerDeps();
    for (const [method, path] of paths) {
      for (const key of [null, "", "wrong-key", `${KEY}x`]) {
        const res = await handleRequest(request(path, { method, key }), deps);
        expect(res.status, `${method} ${path} key=${String(key)}`).toBe(401);
        expect(await res.json()).toEqual({ error: "missing or wrong x-spike-key header" });
      }
    }
    expect(deps.calls).toEqual([]);
  });

  it("answers 503 on every route when the SPIKE_KEY secret is unset, whatever the header says", async () => {
    for (const spikeKey of [undefined, "", "too-short"]) {
      const deps = routerDeps({ spikeKey });
      for (const [method, path] of paths) {
        for (const key of [null, "", "too-short", KEY]) {
          const res = await handleRequest(request(path, { method, key }), deps);
          expect(res.status, `${method} ${path} secret=${String(spikeKey)} key=${String(key)}`).toBe(503);
        }
      }
      expect(deps.calls).toEqual([]);
    }
  });
});

describe("handleRequest: routes", () => {
  it("GET / lists the experiments", async () => {
    const res = await handleRequest(request("/"), routerDeps());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { experiments: string[] }).experiments).toEqual([
      "e1-create-push",
      "e2-minted-token",
      "e3-compare-and-swap",
      "e4-refs",
      "e5-fork",
      "e6-read-by-ref",
      "e7-soak",
      "e8-raw-pack",
      "e9-workers-ai",
      "cleanup",
    ]);
  });

  it("POST /run/<id> passes the JSON body through and returns the result", async () => {
    const deps = routerDeps();
    const res = await handleRequest(request("/run/e5-fork", { method: "POST", body: '{"n": 3}' }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ experiment: "e5-fork", ok: true });
    expect(deps.calls).toEqual([{ id: "e5-fork", body: { n: 3 } }]);
    const empty = await handleRequest(request("/run/e1-create-push", { method: "POST" }), deps);
    expect(empty.status).toBe(200);
    expect(deps.calls[1]).toEqual({ id: "e1-create-push", body: {} });
  });

  it("rejects wrong methods, unknown ids and bad bodies with JSON, without running anything", async () => {
    const deps = routerDeps();
    expect((await handleRequest(request("/run/e1-create-push", { method: "GET" }), deps)).status).toBe(405);
    const unknown = await handleRequest(request("/run/e0-nope", { method: "POST" }), deps);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ experiment: "e0-nope", ok: false, observations: expect.any(Array), timings_ms: {}, http: [] });
    for (const body of ["{not json", "[1,2]", '"text"', "null"]) {
      const bad = await handleRequest(request("/run/e1-create-push", { method: "POST", body }), deps);
      expect(bad.status, body).toBe(400);
      expect(await bad.json()).toMatchObject({ experiment: "e1-create-push", ok: false });
    }
    expect((await handleRequest(request("/nope"), deps)).status).toBe(404);
    expect(deps.calls).toEqual([]);
  });

  it("refuses a body over the size limit with 413, before parsing it and without running anything", async () => {
    const deps = routerDeps();
    // The case from the independent check: 5,000 model names in an 8 MiB body.
    const huge = JSON.stringify({ models: Array.from({ length: 5000 }, (_, i) => `m${i}`), pad: "x".repeat(8 * 1024 * 1024) });
    const big = await handleRequest(request("/run/e9-workers-ai", { method: "POST", body: huge }), deps);
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ experiment: "e9-workers-ai", ok: false, error: `request body is larger than ${MAX_BODY_BYTES} bytes` });

    // A Content-Length over the limit is refused on the header alone.
    const declared = await handleRequest(
      new Request("https://spike.example/run/e9-workers-ai", { method: "POST", headers: { "x-spike-key": KEY, "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" }),
      deps,
    );
    expect(declared.status).toBe(413);

    // Same body as a stream with no Content-Length: the handler stops reading at the limit.
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 2048) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = await handleRequest(
      new Request("https://spike.example/run/e4-refs", { method: "POST", headers: { "x-spike-key": KEY }, body: stream, duplex: "half" } as RequestInit),
      deps,
    );
    expect(streamed.status).toBe(413);
    // 8 MiB were on offer; only a little over the 16 KiB limit was read.
    expect(pulled).toBeLessThan(20);

    // A body just under the limit still works.
    const under = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES - 20) });
    expect(new TextEncoder().encode(under).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect((await handleRequest(request("/run/e1-create-push", { method: "POST", body: under }), deps)).status).toBe(200);
    expect(deps.calls.map((c) => c.id)).toEqual(["e1-create-push"]);
  });

  it("never throws to the client: a failing Durable Object call becomes a JSON result with the token redacted", async () => {
    const deps = routerDeps({
      run: async () => {
        throw new Error("Durable Object reset; token art_v1_0123456789abcdef0123456789abcdef01234567?expires=1 leaked into the message");
      },
    });
    const res = await handleRequest(request("/run/e7-soak", { method: "POST" }), deps);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ExperimentResult;
    expect(body).toMatchObject({ experiment: "e7-soak", ok: false, timings_ms: {}, http: [] });
    expect(body.error).toContain("Durable Object reset");
    expect(JSON.stringify(body)).not.toContain("0123456789abcdef0123456789abcdef01234567");
  });
});

describe("run-spikes.sh against the real handler on localhost", () => {
  let root: string;
  let resultsDir: string;
  /** Files for the outside-probe.mjs tests; kept apart from the run folders in resultsDir. */
  let probeDir: string;
  let gitServer: GitServer;
  let worker: Server;
  let origin: string;
  let fake: FakeArtifacts;
  const seen: { path: string; hadKey: boolean }[] = [];
  /** Paths for which the test server drops the connection without answering. */
  const drop = new Set<string>();

  beforeAll(async () => {
    root = makeTempDir("runner-repos");
    resultsDir = makeTempDir("runner-results");
    probeDir = makeTempDir("outside-probe");
    fake = new FakeArtifacts(root, (repo) => gitServer.remoteFor(repo));
    gitServer = await startGitServer({ root, authorize: fake.authorize });
    const state = new Map<string, unknown>();
    const deps: Deps = {
      artifacts: fake as unknown as Artifacts,
      ai: {
        // Minimal model: says DONE at once, so e9 reports "not correct" (ok=false).
        run: async () => ({ choices: [{ index: 0, message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] }),
      },
      store: { get: async <T>(k: string) => state.get(k) as T | undefined, put: async (k: string, v: unknown) => void state.set(k, v), delete: async (k: string) => state.delete(k) },
      warm: {},
      meta: {},
    };
    worker = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
        seen.push({ path: req.url ?? "", hadKey: headers.get("x-spike-key") === KEY });
        if (drop.has(req.url ?? "")) {
          req.socket.destroy();
          return;
        }
        const method = req.method ?? "GET";
        const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
        const response = await handleRequest(new Request(`http://localhost${req.url}`, { method, headers, body }), {
          spikeKey: KEY,
          experimentIds: EXPERIMENT_IDS,
          meta: { worker_colo: "TEST" },
          run: (id, experimentBody, meta) => runExperiment(id, { ...deps, meta }, experimentBody),
        });
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await gitServer.close();
    removeDir(root);
    removeDir(resultsDir);
    removeDir(probeDir);
  });

  function runScript(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [join(PROJECT_ROOT, "run-spikes.sh"), ...args], {
        cwd: PROJECT_ROOT,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, RESULTS_DIR: resultsDir, ...env } as unknown as NodeJS.ProcessEnv,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  function latestRun(): string {
    const runs = readdirSync(resultsDir).sort();
    return join(resultsDir, runs[runs.length - 1]!);
  }

  it("refuses to start without a URL or without SPIKE_KEY", async () => {
    expect((await runScript([], { SPIKE_KEY: KEY })).code).toBe(2);
    const noKey = await runScript([origin], {});
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("SPIKE_KEY is not set");
    expect((await runScript(["not-a-url"], { SPIKE_KEY: KEY })).code).toBe(2);
  });

  it("stops before running any experiment when the key is wrong", async () => {
    seen.length = 0;
    const wrong = "wrong-key-wrong-key-wrong-key-wrong";
    const result = await runScript([origin], { SPIKE_KEY: wrong });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 401");
    expect(seen.map((s) => s.path)).toEqual(["/"]);
    expect(result.stdout + result.stderr).not.toContain(wrong);
  });

  it("runs e1 to e9 in order, saves one JSON file each, prints one summary line each, and never prints the key", async () => {
    seen.length = 0;
    const result = await runScript([origin], { SPIKE_KEY: KEY, E5_N: "2", E7_K: "3" });
    const output = result.stdout + result.stderr;
    // SHOW_RUNNER_OUTPUT=1 npx vitest run test/router-and-runner.test.ts prints what the script printed.
    if (process.env.SHOW_RUNNER_OUTPUT) console.log(output);
    expect(output).not.toContain(KEY);

    const expected = ["e1-create-push", "e2-minted-token", "e3-compare-and-swap", "e4-refs", "e5-fork", "e6-read-by-ref", "e7-soak", "e8-raw-pack", "e9-workers-ai"];
    expect(seen.map((s) => s.path)).toEqual(["/", ...expected.map((id) => `/run/${id}`)]);
    expect(seen.every((s) => s.hadKey)).toBe(true);

    const dir = latestRun();
    for (const id of expected) {
      const saved = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as ExperimentResult;
      expect(saved.experiment).toBe(id);
      expect(saved.ok, `${id}: ${saved.error ?? ""} ${saved.observations.join(" | ")}`).toBe(id !== "e9-workers-ai");
      expect(existsSync(join(dir, `${id}.json.stderr`))).toBe(false);
      for (const token of fake.issued) expect(readFileSync(join(dir, `${id}.json`), "utf8")).not.toContain(token.split("?")[0]!);
    }
    // Body parameters reached the experiments.
    expect((JSON.parse(readFileSync(join(dir, "e5-fork.json"), "utf8")) as ExperimentResult).data!.verdict).toMatchObject({ forks_requested: 2 });
    expect((JSON.parse(readFileSync(join(dir, "e7-soak.json"), "utf8")) as ExperimentResult).data!.verdict).toMatchObject({ cycles_requested: 3, cycles_run: 3 });
    expect((JSON.parse(readFileSync(join(dir, "e1-create-push.json"), "utf8")) as ExperimentResult).data!.env).toMatchObject({ worker_colo: "TEST" });

    // One summary line per experiment, in order.
    const lines = result.stdout.split("\n").filter((line) => /^e\d-/.test(line));
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual(expected);
    for (const line of lines.slice(0, 8)) expect(line).toMatch(/ok=true\s+http=200 [\d.]+s verdict=\{/);
    expect(lines[8]).toMatch(/^e9-workers-ai\s+ok=false\s+http=200/);
    expect(result.stdout).toContain("1 of 9 experiments reported ok=false");
    expect(result.stdout).toContain("run this script again with: cleanup");
    // e9 is ok=false with this stub model, so the script exits 1.
    expect(result.code).toBe(1);
    expect([...fake.repos.keys()].every((name) => name.startsWith("spike-"))).toBe(true);
    // One repo each from e1, e3, e4, e6, e7 and e8, plus the two forks from e5.
    expect(fake.repos.size).toBe(8);
  }, 180_000);

  it("runs only the named experiments, and cleanup deletes the spike repos", async () => {
    seen.length = 0;
    const result = await runScript([origin, "cleanup"], { SPIKE_KEY: KEY });
    expect(result.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/", "/run/cleanup"]);
    expect(result.stdout).toMatch(/^cleanup\s+ok=true\s+http=200 [\d.]+s verdict=\{"matched":\d+,"deleted":\d+/m);
    expect(result.stdout).toContain("All 1 experiments reported ok=true.");
    expect(result.stdout).not.toContain("still there");
    expect(fake.repos.size).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it("with E2_OUTSIDE_CONTROL it probes the e2 token inside, from this machine, and inside again, and removes the token from the saved file", async () => {
    seen.length = 0;
    const before = gitServer.requests.length;
    const result = await runScript([origin, "e1-create-push", "e2-minted-token"], { SPIKE_KEY: KEY, E2_OUTSIDE_CONTROL: "1" });
    const output = result.stdout + result.stderr;
    expect(result.code, output).toBe(0);
    // The third request is the second inside probe, asked for by outside-probe.mjs with the same key.
    expect(seen.map((s) => s.path)).toEqual(["/", "/run/e1-create-push", "/run/e2-minted-token", "/run/e2-minted-token"]);
    expect(seen.every((s) => s.hadKey)).toBe(true);
    expect(output).not.toContain(KEY);

    const file = join(latestRun(), "e2-minted-token.json");
    const text = readFileSync(file, "utf8");
    const saved = JSON.parse(text) as ExperimentResult & { outside_probe: { pairs: unknown[]; inside_recheck: unknown; minted_token_refused_only_inside_workers: unknown; conclusion: string } };
    expect(saved.ok).toBe(true);
    // The token is gone from the file, and it was never printed.
    expect(saved.disclosed).toMatchObject({ token: "<removed by outside-probe.mjs after use>", service: "git-upload-pack", scope: "read" });
    expect(fake.issued.length).toBeGreaterThan(3);
    for (const token of fake.issued) {
      expect(text).not.toContain(token.split("?")[0]!);
      expect(output).not.toContain(token.split("?")[0]!);
    }
    // Same token, same requests, in three rounds: inside (the handler), outside (curl), inside again.
    // All accepted by this server.
    expect(saved.outside_probe.pairs).toEqual(
      ["bearer", "basic"].flatMap((auth) =>
        ["none set", "git/2.50.1"].flatMap((user_agent) =>
          ["GET info/refs", "POST git-upload-pack"].map((request) => ({ request, auth, user_agent, inside_status_before: 200, outside_status: 200, inside_status_after: 200 })),
        ),
      ),
    );
    expect(saved.outside_probe.inside_recheck).toMatchObject({ done: true, token_expired_before_end: false });
    expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(false);
    expect(result.stdout).toContain("outside control: the token was accepted inside the Durable Object and from this machine (GET info/refs and POST git-upload-pack)");
    expect(result.stdout).toContain("statuses as inside>outside>inside again: GET bearer/no-ua 200>200>200; POST bearer/no-ua 200>200>200; GET bearer/git-ua 200>200>200;");
    // The git server saw the requests from curl: four with no User-Agent header at all (two GET,
    // two POST), and twelve with git's User-Agent (four in each of the three rounds).
    const requests = gitServer.requests.slice(before);
    expect(requests.filter((r) => r.userAgent === undefined).map((r) => r.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(requests.filter((r) => r.userAgent === "git/2.50.1")).toHaveLength(12);
  });

  describe("outside-probe.mjs", () => {
    function runProbe(file: string, base?: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn("node", [join(PROJECT_ROOT, "outside-probe.mjs"), file, ...(base === undefined ? [] : [base])], { env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    }

    const AUTHS = ["bearer", "basic"];
    const AGENTS = ["none set", "git/2.50.1"];
    const REQUESTS = ["GET info/refs", "POST git-upload-pack"];
    /** One status per request, in the order e2 sends them. `status` may depend on the request. */
    function round(status: (request: string) => number) {
      return AUTHS.flatMap((auth) => AGENTS.flatMap((user_agent) => REQUESTS.map((request) => ({ request, auth, user_agent, status: status(request) }))));
    }
    const e1Repo = () => [...fake.repos.keys()].find((n) => n.startsWith("spike-e1-"))!;

    /** A saved e2 result as the Worker would return it, with the given statuses from the first inside probe. */
    function savedResult(name: string, token: string, repo: string, insideStatus: (request: string) => number): string {
      const file = join(probeDir, name);
      const tip = git(fake.repoPath(repo), ["rev-parse", "refs/heads/main"]).trim();
      const result = {
        experiment: "e2-minted-token",
        ok: false,
        observations: [],
        timings_ms: {},
        http: [],
        data: { verdict: {}, outside_control: { inside_durable_object: round(insideStatus) } },
        disclosed: {
          remote: gitServer.remoteFor(repo),
          service: "git-upload-pack",
          scope: "read",
          token,
          minted_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          git_user_agent: "git/2.50.1",
          post: { path: "/git-upload-pack", content_type: "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result", body: `0032want ${tip}\n00000009done\n` },
        },
      };
      writeFileSync(file, JSON.stringify(result));
      return file;
    }

    /** Stands in for the Worker on the recheck request: answers with the given e2 result. */
    async function cannedWorker(answer: unknown): Promise<{ origin: string; requests: { path: string; key: string | undefined; body: string }[]; close(): Promise<void> }> {
      const requests: { path: string; key: string | undefined; body: string }[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          requests.push({ path: req.url ?? "", key: req.headers["x-spike-key"] as string | undefined, body: Buffer.concat(chunks).toString("utf8") });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(answer));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    }
    const recheckAnswer = (status: (request: string) => number, expired = false) => ({
      experiment: "e2-minted-token",
      ok: !expired,
      observations: [],
      timings_ms: {},
      http: [],
      data: { verdict: {}, outside_control_recheck: { token_expired_before_end: expired, inside_durable_object: round(status) } },
    });

    type SavedProbe = { outside_probe: { minted_token_refused_only_inside_workers: unknown; conclusion: string; inside_recheck: { done: boolean; reason?: string }; pairs: { request: string; inside_status_before: number | null; outside_status: number; inside_status_after: number | null }[] } };
    const readSaved = (file: string) => JSON.parse(readFileSync(file, "utf8")) as SavedProbe;

    /** A token that was refused (403) on the first inside probe and is accepted from this machine. */
    async function refusedInsideAcceptedOutside(name: string, base: string | undefined, env: Record<string, string> = {}, insideStatus: (request: string) => number = () => 403) {
      const repo = e1Repo();
      const token = fake.mint(repo, "read", 60).plaintext;
      const file = savedResult(name, token, repo, insideStatus);
      const run = await runProbe(file, base, env);
      expect(run.code, run.stderr).toBe(0);
      const saved = readSaved(file);
      expect(saved.outside_probe.pairs.map((p) => p.outside_status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
      expect(readFileSync(file, "utf8") + run.stdout + run.stderr).not.toContain(token.split("?")[0]!);
      expect(run.stdout + run.stderr).not.toContain(KEY);
      return { saved, run };
    }

    it("reports 'inconclusive', not 'refused only inside Workers', when the token got 403 inside and 200 from this machine but was not probed inside again", async () => {
      // Refused inside first, accepted outside later: an origin-dependent refusal and a token
      // that needed time to become valid look the same. The old script answered "true" here.
      const { saved } = await refusedInsideAcceptedOutside("refused-inside-no-recheck.json", undefined);
      expect(saved.outside_probe.inside_recheck).toEqual({ done: false, reason: "no Worker base URL was given to outside-probe.mjs" });
      expect(saved.outside_probe.pairs.every((p) => p.inside_status_after === null)).toBe(true);
      expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe("inconclusive");
      expect(saved.outside_probe.conclusion).toBe(
        "inconclusive: 8 request(s) were refused inside the Durable Object and accepted from this machine afterwards, but there is no usable second probe from inside (no Worker base URL was given to outside-probe.mjs). A token that needs time to become valid gives the same picture, so this does not show that the origin matters",
      );
    });

    it("concludes 'refused only inside Workers' when the token is still refused inside AFTER this machine was accepted", async () => {
      const worker = await cannedWorker(recheckAnswer(() => 403));
      try {
        const { saved } = await refusedInsideAcceptedOutside("refused-inside-before-and-after.json", worker.origin, { SPIKE_KEY: KEY });
        expect(saved.outside_probe.pairs.every((p) => p.inside_status_before === 403 && p.inside_status_after === 403)).toBe(true);
        expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(true);
        expect(saved.outside_probe.conclusion).toMatch(/^the same token was refused inside the Durable Object before AND after it was accepted from this machine: the refusal depends on where the request comes from; the age of the token alone does not explain it\. Requests: GET info\/refs \(bearer auth, no User-Agent\); POST git-upload-pack \(bearer auth, no User-Agent\);/);
        // The recheck was one authenticated POST with exactly this body.
        expect(worker.requests).toEqual([{ path: "/run/e2-minted-token", key: KEY, body: '{"outside_control_recheck": true}' }]);
      } finally {
        await worker.close();
      }
    });

    it("concludes 'the token needed time' (not origin) when the second inside probe is accepted", async () => {
      const worker = await cannedWorker(recheckAnswer(() => 200));
      try {
        const { saved } = await refusedInsideAcceptedOutside("refused-inside-then-accepted.json", worker.origin, { SPIKE_KEY: KEY });
        expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(false);
        expect(saved.outside_probe.conclusion).toMatch(/^the token was refused inside the Durable Object at first, then accepted from this machine, then accepted inside as well: a new token needs time to become valid\. The origin of the request makes no difference/);
      } finally {
        await worker.close();
      }
    });

    it("finds a refusal that happens only on POST and only inside", async () => {
      const onlyPost = (request: string) => (request.startsWith("POST") ? 403 : 200);
      const worker = await cannedWorker(recheckAnswer(onlyPost));
      try {
        const { saved } = await refusedInsideAcceptedOutside("refused-inside-on-post.json", worker.origin, { SPIKE_KEY: KEY }, onlyPost);
        expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(true);
        expect(saved.outside_probe.conclusion).toContain("Requests: POST git-upload-pack (bearer auth, no User-Agent); POST git-upload-pack (bearer auth, git User-Agent); POST git-upload-pack (basic auth, no User-Agent); POST git-upload-pack (basic auth, git User-Agent)");
        expect(saved.outside_probe.conclusion).not.toContain("GET info/refs (");
      } finally {
        await worker.close();
      }
    });

    it("reports 'inconclusive' when the token expired before the second inside probe had finished", async () => {
      const worker = await cannedWorker(recheckAnswer(() => 401, true));
      try {
        const { saved } = await refusedInsideAcceptedOutside("recheck-expired.json", worker.origin, { SPIKE_KEY: KEY });
        // Statuses from after the expiry are not used.
        expect(saved.outside_probe.pairs.every((p) => p.inside_status_after === null)).toBe(true);
        expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe("inconclusive");
        expect(saved.outside_probe.conclusion).toContain("there is no usable second probe from inside (the token expired before the second probe inside the Durable Object had finished)");
      } finally {
        await worker.close();
      }
    });

    it("reports 'inconclusive' when the Worker did not run the recheck, and when SPIKE_KEY is not set", async () => {
      const busy = { experiment: "e2-minted-token", ok: false, observations: [], timings_ms: {}, http: [], error: 'busy: experiment "e7-soak" has been running on this Durable Object for 1200 ms; one experiment runs at a time. Nothing was run.' };
      const worker = await cannedWorker(busy);
      try {
        const refusedByWorker = await refusedInsideAcceptedOutside("recheck-busy.json", worker.origin, { SPIKE_KEY: KEY });
        expect(refusedByWorker.saved.outside_probe.minted_token_refused_only_inside_workers).toBe("inconclusive");
        expect(refusedByWorker.saved.outside_probe.inside_recheck).toEqual({ done: false, reason: 'the Worker did not run the recheck: busy: experiment "e7-soak" has been running on this Durable Object for 1200 ms; one experiment runs at a time. Nothing was run.' });

        worker.requests.length = 0;
        const noKey = await refusedInsideAcceptedOutside("recheck-no-key.json", worker.origin, {});
        expect(noKey.saved.outside_probe.minted_token_refused_only_inside_workers).toBe("inconclusive");
        expect(noKey.saved.outside_probe.inside_recheck).toEqual({ done: false, reason: "SPIKE_KEY is not set in the environment" });
        // Without the key, nothing is sent to the Worker.
        expect(worker.requests).toEqual([]);
      } finally {
        await worker.close();
      }
    });

    it("concludes 'no difference' when the token is refused inside and from this machine alike", async () => {
      const repo = e1Repo();
      // A token the server does not know: 401 from this machine, and the file says 401 from inside.
      const token = `art_v1_${"0".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 60}`;
      const file = savedResult("refused-everywhere.json", token, repo, () => 401);
      const run = await runProbe(file);
      expect(run.code, run.stderr).toBe(0);
      const saved = readSaved(file);
      expect(saved.outside_probe.pairs.map((p) => p.outside_status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
      expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(false);
      expect(saved.outside_probe.conclusion).toMatch(/^every request got the same status/);
    });

    it("still works on a saved result that holds no POST request, and says that only GET was compared", async () => {
      const repo = e1Repo();
      const token = fake.mint(repo, "read", 60).plaintext;
      const file = join(probeDir, "get-only.json");
      const inside = AUTHS.flatMap((auth) => AGENTS.map((user_agent) => ({ auth, user_agent, status: 200 })));
      writeFileSync(file, JSON.stringify({ experiment: "e2-minted-token", ok: true, observations: [], timings_ms: {}, http: [], data: { outside_control: { inside_durable_object: inside } }, disclosed: { remote: gitServer.remoteFor(repo), service: "git-upload-pack", token, expires_at: new Date(Date.now() + 60_000).toISOString() } }));
      const run = await runProbe(file);
      expect(run.code, run.stderr).toBe(0);
      const saved = readSaved(file);
      expect(saved.outside_probe.pairs.map((p) => [p.request, p.inside_status_before, p.outside_status])).toEqual(Array.from({ length: 4 }, () => ["GET info/refs", 200, 200]));
      expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(false);
      expect(saved.outside_probe.conclusion).toBe("the token was accepted inside the Durable Object and from this machine (GET info/refs only (the result held no POST request to repeat))");
    });

    it("reports 'inconclusive' when no request gets an HTTP answer, and masks the account label in the saved remote", async () => {
      const file = join(probeDir, "no-answer.json");
      const token = `art_v1_${"1".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 60}`;
      // ".invalid" never resolves (RFC 2606), so curl gets no HTTP answer and nothing leaves this machine.
      const remote = "https://acct-label-123.artifacts.cloudflare.net.invalid/git/spike/spike-e1-x.git";
      writeFileSync(file, JSON.stringify({ experiment: "e2-minted-token", ok: true, observations: [], timings_ms: {}, http: [], data: { outside_control: { inside_durable_object: [] } }, disclosed: { remote, service: "git-upload-pack", token, expires_at: new Date(Date.now() + 60_000).toISOString() } }));
      const run = await runProbe(file);
      expect(run.code, run.stderr).toBe(0);
      const text = readFileSync(file, "utf8");
      const saved = JSON.parse(text) as { disclosed: { remote: string; token: string }; outside_probe: { minted_token_refused_only_inside_workers: unknown; conclusion: string } };
      expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe("inconclusive");
      expect(saved.outside_probe.conclusion).toBe("inconclusive: at least one request from this machine got no HTTP answer");
      expect(saved.disclosed.remote).toBe("https://<account>.artifacts.cloudflare.net.invalid/git/spike/spike-e1-x.git");
      expect(text).not.toContain("acct-label-123");
      expect(text + run.stdout + run.stderr).not.toContain("1".repeat(40));
    }, 60_000);

    it("exits 1 and sends nothing when the result holds no disclosed token", async () => {
      const file = join(probeDir, "no-token.json");
      writeFileSync(file, JSON.stringify({ experiment: "e2-minted-token", ok: true, observations: [], timings_ms: {}, http: [] }));
      const before = gitServer.requests.length;
      const run = await runProbe(file);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('the result holds no token under "disclosed"');
      expect(gitServer.requests.length).toBe(before);
    });

    it("exits 1 and sends nothing when the disclosed POST request does not belong to the disclosed service", async () => {
      const repo = e1Repo();
      const token = fake.mint(repo, "read", 60).plaintext;
      const file = savedResult("bad-post.json", token, repo, () => 200);
      const tampered = JSON.parse(readFileSync(file, "utf8")) as { disclosed: { post: { path: string } } };
      tampered.disclosed.post.path = "/git-receive-pack";
      writeFileSync(file, JSON.stringify(tampered));
      const before = gitServer.requests.length;
      const run = await runProbe(file);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("the disclosed POST request is not usable; the token was removed from the file and no request was sent");
      expect(readFileSync(file, "utf8")).not.toContain(token.split("?")[0]!);
      expect(gitServer.requests.length).toBe(before);
    });
  });

  it("stops with a clear message when the Worker cannot be reached", async () => {
    // Nothing listens on port 9 here: the pre-check fails and the script stops.
    const result = await runScript(["http://127.0.0.1:9"], { SPIKE_KEY: KEY, MAX_TIME: "5" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/GET http:\/\/127\.0\.0\.1:9\/ failed \(curl exit \d+/);
  });

  it("still saves a JSON result when one request dies without a response", async () => {
    drop.add("/run/e3-compare-and-swap");
    try {
      const result = await runScript([origin, "e3-compare-and-swap"], { SPIKE_KEY: KEY });
      expect(result.code).toBe(1);
      const saved = JSON.parse(readFileSync(join(latestRun(), "e3-compare-and-swap.json"), "utf8")) as ExperimentResult;
      expect(saved).toMatchObject({ experiment: "e3-compare-and-swap", ok: false, http: [], timings_ms: {} });
      expect(saved.error).toMatch(/^curl exit \d+/);
      expect(result.stdout).toMatch(/^e3-compare-and-swap\s+ok=false\s+http=000 .* error=curl exit \d+/m);
      expect(result.stdout + result.stderr).not.toContain(KEY);
    } finally {
      drop.clear();
    }
  });
});
