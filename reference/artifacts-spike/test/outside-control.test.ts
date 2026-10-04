/**
 * The e2 outside control, end to end, in worlds with ONE known property each.
 *
 * The flow under test is the operator's: e2 with {"outside_control": ...} through the real
 * request handler over HTTP, the answer saved to a file, then the real outside-probe.mjs
 * (curl) with the Worker's base URL and key, which also makes the second inside probe.
 *
 * Expected verdicts follow from the known property of each world:
 *  - a token that every caller must wait for is NOT "refused only inside Workers";
 *  - a token that is refused for one kind of caller only IS, also when only POST is refused.
 *
 * "Inside Workers" cannot exist on a laptop. The stand-in is a property the two callers
 * really differ in: Node's fetch (the experiment code) sends a "sec-fetch-mode" header,
 * curl (outside-probe.mjs) does not. Each test first checks that premise.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Deps, RepoState, WarmState } from "../src/experiments";
import { GIT_CLI_USER_AGENT } from "../src/experiments/e2-minted-token";
import { secretForms, sleep, type ExperimentResult } from "../src/recorder";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { git, makeTempDir, removeDir, startGitServer, type AuthRequest, type AuthResult, type GitServer } from "./helpers/git-http-server";
import { secretFromAuthorization, startProxy, type Proxy, type ProxyHook } from "./helpers/proxy";
import { startWorkerServer, type WorkerServer } from "./helpers/worker-server";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "outside-control-test-key-0123456789abcdef";

interface Pair {
  request: string;
  auth: string;
  user_agent: string;
  inside_status_before: number | null;
  outside_status: number;
  inside_status_after: number | null;
}

interface Saved extends ExperimentResult {
  outside_probe: {
    requests: string[];
    pairs: Pair[];
    inside_recheck: { done: boolean; reason?: string; token_expired_before_end?: boolean };
    minted_token_refused_only_inside_workers: boolean | string;
    conclusion: string;
  };
}

interface World {
  fake: FakeArtifacts;
  server: GitServer;
  worker: WorkerServer;
  state: Map<string, unknown>;
  dir: string;
}

interface WorldOptions {
  makeFake?: (root: string, remoteFor: (repo: string) => string) => FakeArtifacts;
  authorize?: (fake: FakeArtifacts) => (req: AuthRequest) => AuthResult;
  hook?: (fake: FakeArtifacts) => ProxyHook;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const root = makeTempDir("outside-control-repos");
  const dir = makeTempDir("outside-control-results");
  let server: GitServer | undefined;
  let proxy: Proxy | null = null;
  const remoteFor = (repo: string) => `${proxy ? proxy.origin : server!.origin}/git/spike/${repo}.git`;
  const fake = options.makeFake ? options.makeFake(root, remoteFor) : new FakeArtifacts(root, remoteFor);
  server = await startGitServer({ root, authorize: options.authorize ? options.authorize(fake) : fake.authorize });
  if (options.hook) proxy = await startProxy(() => server!.origin, options.hook(fake));
  const state = new Map<string, unknown>();
  const warm: WarmState = {};
  const deps: Deps = {
    artifacts: fake as unknown as Artifacts,
    ai: { run: async () => ({ response: "DONE" }) },
    store: {
      get: async <T>(key: string) => state.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void state.set(key, structuredClone(value)),
      delete: async (key: string) => state.delete(key),
    },
    warm,
    meta: {},
  };
  const worker = await startWorkerServer(deps, KEY);
  cleanups.push(async () => {
    await worker.close();
    await proxy?.close();
    await server!.close();
    removeDir(root);
    removeDir(dir);
  });
  return { fake, server, worker, state, dir };
}

/** POST /run/<id> on the Worker, as run-spikes.sh does. */
async function call(world: World, id: string, body: Record<string, unknown> = {}): Promise<ExperimentResult> {
  const res = await fetch(`${world.worker.origin}/run/${id}`, { method: "POST", headers: { "x-spike-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as ExperimentResult;
}

function runProbe(file: string, base: string | null, env: Record<string, string> = { SPIKE_KEY: KEY }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [join(PROJECT_ROOT, "outside-probe.mjs"), file, ...(base === null ? [] : [base])];
    const child = spawn("node", args, { env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Run e1, then e2 with the outside control, save the answer, run outside-probe.mjs, and return the saved file. */
async function control(world: World, body: Record<string, unknown>, beforeProbe: (e2: ExperimentResult, returnedAt: number) => Promise<void> = async () => {}) {
  expect((await call(world, "e1-create-push")).ok).toBe(true);
  const e2 = await call(world, "e2-minted-token", body);
  const returnedAt = Date.now();
  const file = join(world.dir, "e2-minted-token.json");
  writeFileSync(file, JSON.stringify(e2, null, 2));
  await beforeProbe(e2, returnedAt);
  const run = await runProbe(file, world.worker.origin);
  expect(run.code, run.stderr).toBe(0);
  const text = readFileSync(file, "utf8");
  // Token and key hygiene: nothing left in the file, nothing printed.
  for (const token of world.fake.issued) for (const form of secretForms(token)) expect((text + run.stdout + run.stderr).includes(form), "a token form is in the saved file or was printed").toBe(false);
  expect(text + run.stdout + run.stderr).not.toContain(KEY);
  return { e2, saved: JSON.parse(text) as Saved, run };
}

const statuses = (pairs: Pair[], request: string) => pairs.filter((p) => p.request === request).map((p) => [p.inside_status_before, p.outside_status, p.inside_status_after]);

describe("the outside control separates the origin of a request from the age of the token", () => {
  it("a token that EVERY caller must wait for is not reported as 'refused only inside Workers'", async () => {
    // The world's only property: a token from createToken() is refused for DELAY_MS after
    // it was minted, whoever asks. The inside probe comes milliseconds after minting; the
    // operator's machine comes later. Before the fix this read as "refused only inside".
    const DELAY_MS = 2000;
    const mintedAt = new Map<string, number>();
    class TimedFake extends FakeArtifacts {
      override mint(repo: string, scope: "read" | "write", ttl: number) {
        const token = super.mint(repo, scope, ttl);
        mintedAt.set(token.secret, Date.now());
        return token;
      }
    }
    const world = await makeWorld({
      makeFake: (root, remoteFor) => new TimedFake(root, remoteFor),
      authorize: (fake) => (req) => {
        const secret = secretFromAuthorization(req.authorization);
        if (fake.minted.has(secret) && Date.now() - (mintedAt.get(secret) ?? 0) < DELAY_MS) return { status: 403, body: "token not valid yet (simulated propagation delay)" };
        return fake.authorize(req);
      },
    });
    const { e2, saved } = await control(world, { outside_control: true, token_wait_ms: 10_000 }, async (_e2, returnedAt) => {
      // The operator's machine sends its requests after the answer has travelled back.
      await sleep(Math.max(0, DELAY_MS + 300 - (Date.now() - returnedAt)));
    });
    // e2 itself saw the delay and said so.
    expect((e2.data!.verdict as Record<string, unknown>).needed_token_propagation_wait).toBe(true);

    const probe = saved.outside_probe;
    expect(probe.pairs).toHaveLength(8);
    // Premise: refused inside at first, accepted from this machine, accepted inside afterwards.
    for (const pair of probe.pairs) expect([pair.inside_status_before, pair.outside_status, pair.inside_status_after], `${pair.request} ${pair.auth}`).toEqual([403, 200, 200]);
    expect(probe.inside_recheck).toMatchObject({ done: true, token_expired_before_end: false });
    expect(probe.minted_token_refused_only_inside_workers).toBe(false);
    expect(probe.conclusion).toMatch(/^the token was refused inside the Durable Object at first, then accepted from this machine, then accepted inside as well: a new token needs time to become valid\. The origin of the request makes no difference/);
  }, 60_000);

  it("a token that is refused for one kind of caller, before and after the other caller is accepted, IS 'refused only inside Workers'", async () => {
    const world = await makeWorld({
      hook: (fake) => (req) => (fake.minted.has(secretFromAuthorization(req.headers.authorization)) && req.headers["sec-fetch-mode"] !== undefined ? { status: 403, body: "forbidden for this caller (simulated issue 15429)" } : undefined),
    });
    const { e2, saved, run } = await control(world, { outside_control: true, token_wait_ms: 300 });
    expect(e2.ok).toBe(false);
    expect((e2.data!.verdict as Record<string, unknown>).bug_15429_reproduced).toBe(true);

    const probe = saved.outside_probe;
    expect(probe.requests).toEqual(["GET <remote>/info/refs?service=git-upload-pack", "POST <remote>/git-upload-pack"]);
    for (const pair of probe.pairs) expect([pair.inside_status_before, pair.outside_status, pair.inside_status_after], `${pair.request} ${pair.auth}`).toEqual([403, 200, 403]);
    expect(probe.minted_token_refused_only_inside_workers).toBe(true);
    expect(probe.conclusion).toMatch(/^the same token was refused inside the Durable Object before AND after it was accepted from this machine: the refusal depends on where the request comes from; the age of the token alone does not explain it/);
    expect(run.stdout).toContain("statuses as inside>outside>inside again: GET bearer/no-ua 403>200>403; POST bearer/no-ua 403>200>403;");
    // The second inside probe was a request of its own, after the outside requests.
    expect(world.worker.paths).toEqual(["/run/e1-create-push", "/run/e2-minted-token", "/run/e2-minted-token"]);
  }, 60_000);

  it("a refusal on POST only, for one kind of caller only, is found too (GET info/refs alone would miss it)", async () => {
    const world = await makeWorld({
      hook: (fake) => (req) =>
        req.method === "POST" && fake.minted.has(secretFromAuthorization(req.headers.authorization)) && req.headers["sec-fetch-mode"] !== undefined ? { status: 403, body: "forbidden on POST for this caller (simulated)" } : undefined,
    });
    const { saved } = await control(world, { outside_control: true, token_wait_ms: 300 });
    const probe = saved.outside_probe;
    // Every GET info/refs is accepted everywhere: a control that compares only GET says "no difference".
    expect(statuses(probe.pairs, "GET info/refs")).toEqual(Array.from({ length: 4 }, () => [200, 200, 200]));
    expect(statuses(probe.pairs, "POST git-upload-pack")).toEqual(Array.from({ length: 4 }, () => [403, 200, 403]));
    expect(probe.minted_token_refused_only_inside_workers).toBe(true);
    expect(probe.conclusion).toContain("Requests: POST git-upload-pack (bearer auth, no User-Agent); POST git-upload-pack (bearer auth, git User-Agent); POST git-upload-pack (basic auth, no User-Agent); POST git-upload-pack (basic auth, git User-Agent)");
    expect(probe.conclusion).not.toContain("GET info/refs (");
  }, 60_000);
});

describe("the outside control on a server that treats every caller alike", () => {
  it.each([
    [true, "git-upload-pack"],
    ["write", "git-receive-pack"],
  ] as const)("outside_control=%j: every GET and POST is accepted in all three rounds, and the repo is not changed", async (flag, service) => {
    const world = await makeWorld();
    let headBefore = "";
    const { e2, saved } = await control(world, { outside_control: flag }, async () => {
      const repo = (world.state.get("e1") as RepoState).name;
      headBefore = git(world.fake.repoPath(repo), ["rev-parse", "refs/heads/main"]).trim();
    });
    expect(e2.ok).toBe(true);
    const probe = saved.outside_probe;
    expect(probe.pairs.map((p) => `${p.request}|${p.auth}|${p.user_agent}`)).toEqual(
      ["bearer", "basic"].flatMap((auth) => ["none set", GIT_CLI_USER_AGENT].flatMap((ua) => [`GET info/refs|${auth}|${ua}`, `POST ${service}|${auth}|${ua}`])),
    );
    for (const pair of probe.pairs) expect([pair.inside_status_before, pair.outside_status, pair.inside_status_after], `${pair.request} ${pair.auth}`).toEqual([200, 200, 200]);
    expect(probe.minted_token_refused_only_inside_workers).toBe(false);
    expect(probe.conclusion).toBe(`the token was accepted inside the Durable Object and from this machine (GET info/refs and POST ${service})`);
    // 24 control requests (8 per round) left the repo as it was: the POST probes change nothing.
    const repo = (world.state.get("e1") as RepoState).name;
    expect(git(world.fake.repoPath(repo), ["rev-parse", "refs/heads/main"]).trim()).toBe(headBefore);
    expect(git(world.fake.repoPath(repo), ["for-each-ref", "--format=%(refname)"]).trim()).toBe("refs/heads/main");
    const posts = world.server.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/${service}`) && r.status === 200);
    expect(posts.length).toBeGreaterThanOrEqual(12);
  }, 60_000);

  it("without the Worker's URL there is no second inside probe; that changes nothing when nothing was refused", async () => {
    const world = await makeWorld();
    expect((await call(world, "e1-create-push")).ok).toBe(true);
    const e2 = await call(world, "e2-minted-token", { outside_control: true });
    const file = join(world.dir, "e2.json");
    writeFileSync(file, JSON.stringify(e2));
    const run = await runProbe(file, null);
    expect(run.code, run.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
    expect(saved.outside_probe.inside_recheck).toEqual({ done: false, reason: "no Worker base URL was given to outside-probe.mjs" });
    expect(saved.outside_probe.pairs.every((p) => p.inside_status_before === 200 && p.outside_status === 200 && p.inside_status_after === null)).toBe(true);
    expect(saved.outside_probe.minted_token_refused_only_inside_workers).toBe(false);
    expect(world.worker.paths).toEqual(["/run/e1-create-push", "/run/e2-minted-token"]);
  }, 60_000);
});
