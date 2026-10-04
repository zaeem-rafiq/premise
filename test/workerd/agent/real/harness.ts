// test/workerd/agent/real/harness.ts — the deployment for the real-agent
// tests of Slice 4a: the built Worker bundle, its Durable Objects, and two
// loopback stand-ins — a fake Workers AI (`POST {base}/run`, the request is
// recorded and the answer comes from a script) and, for DO-level tests, a
// fake Trunk like the scripted-lane's.
//
// The `AI` binding is a service binding to `fake-ai.mjs`, which forwards each
// `run` to the scripted FakeModel — the same shape a deployment binds. The
// gate is the real `ModelGate` object; `SPEND_CAP_USD` is its cap binding
// (absent = cap 0 = fail closed, so every worker here sets it).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { REPO_ROOT } from "../../../support/source.ts";
import { DURABLE_OBJECTS, type DurableObjectBinding } from "../../../support/workerd.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");
const FAKE_AI = join(REPO_ROOT, "test/workerd/agent/real/fake-ai.mjs");
const ORIGIN = "http://premise.test";

// Workerd honours the proxy variables of the environment; the only remotes of
// this deployment are loopback stand-ins, so no_proxy must cover them.
process.env.no_proxy = "*";
process.env.NO_PROXY = "*";

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };

export type ObjectHandle = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
};

export type RealWorker = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  gate(): ObjectHandle;
  dispose(): Promise<void>;
};

export type RealWorkerOptions = {
  ownerKey?: string;
  /** The fake model's loopback URL, bound as the fake-AI worker's upstream. */
  modelUrl?: string;
  spendCapUsd?: string;
  /** Extra service bindings (the landing harness's fake Artifacts worker). */
  serviceBindings?: Record<string, { name: string }>;
  /** Extra workers (the fake-artifacts worker module itself). */
  extraWorkers?: Array<Record<string, unknown>>;
};

export async function startRealWorker(options: RealWorkerOptions): Promise<RealWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
  const bindings: Record<string, string> = { SPEND_CAP_USD: options.spendCapUsd ?? "30" };
  if (options.ownerKey !== undefined) bindings.OWNER_KEY = options.ownerKey;
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings,
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
          ),
          serviceBindings: {
            // The deployment's own `AI` binding — an entrypoint of the fake-ai
            // worker, bound exactly where wrangler binds Workers AI.
            ...(options.modelUrl === undefined ? {} : { AI: { name: "fake-ai", entrypoint: "AiBinding" } }),
            ...options.serviceBindings,
          },
          assets: {
            directory: CLIENT,
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        ...(options.modelUrl === undefined
          ? []
          : [
              {
                name: "fake-ai",
                modules: [{ type: "ESModule", path: FAKE_AI }],
                compatibilityDate: "2026-10-01",
                compatibilityFlags: ["nodejs_compat"],
                bindings: { MODEL_UPSTREAM: options.modelUrl },
              },
            ]),
        ...(options.extraWorkers ?? []),
      ] as never,
    }),
  );
  await miniflare.ready;

  const namespaces = new Map<DurableObjectBinding, { idFromName(name: string): unknown; get(id: unknown): Stub }>();
  async function namespace(binding: DurableObjectBinding) {
    if (!namespaces.has(binding)) {
      namespaces.set(
        binding,
        (await miniflare.getDurableObjectNamespace(binding)) as unknown as {
          idFromName(name: string): unknown;
          get(id: unknown): Stub;
        },
      );
    }
    return namespaces.get(binding) as { idFromName(name: string): unknown; get(id: unknown): Stub };
  }
  function object(binding: DurableObjectBinding, name: string): ObjectHandle {
    return {
      fetch: async (path, init) =>
        (await namespace(binding)).get((await namespace(binding)).idFromName(name)).fetch(`${ORIGIN}${path}`, init),
    };
  }
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    gate: () => object("GATE", "premise"),
    dispose: () => miniflare.dispose(),
  };
}

// ---------------------------------------------------------------------------
// The fake Workers AI service: `POST {url}/run` with `{model, request}`. Each
// request is recorded; the answer comes off the script — an object is answered
// 200 as the raw provider result, `{ http: N, code? }` is answered with that
// status (a body `{code, retry_after_ms}` rides along when given). An empty
// queue answers a generic stop-free tool call so an over-run is visible.

export type ModelScriptEntry =
  | {
      content?: string;
      tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
      finish_reason?: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }
  | { http: number; code?: number; retry_after_ms?: number }
  | { raw: unknown };

export class FakeModel {
  #server: Server | null = null;
  url = "";
  requests: Array<{ model: string; request: Record<string, unknown> }> = [];
  script: ModelScriptEntry[] = [];
  /** When set, the answer is held until `release()` — a deterministic window
   * in which the in-flight model call (and its journal row) is observable. */
  #held: { seen: (r: { model: string; request: Record<string, unknown> }) => void; release: Promise<void> }[] = [];

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        void this.#handle(JSON.parse(body) as { model: string; request: Record<string, unknown> }).then((r) => {
          res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
          res.end(JSON.stringify(r.json));
        });
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** Defer the next answer until release() — the deterministic in-flight window. */
  hold(): { seen: Promise<{ model: string; request: Record<string, unknown> }>; release: () => void } {
    let releaseFn!: () => void;
    let seenFn!: (r: { model: string; request: Record<string, unknown> }) => void;
    const release = new Promise<void>((r) => (releaseFn = r));
    const seen = new Promise<{ model: string; request: Record<string, unknown> }>((r) => (seenFn = r));
    this.#held.push({ seen: seenFn, release });
    return { seen, release: releaseFn };
  }

  async #handle(body: {
    model: string;
    request: Record<string, unknown>;
  }): Promise<{ status: number; json: unknown; headers?: Record<string, string> }> {
    this.requests.push(body);
    const held = this.#held.shift();
    if (held !== undefined) {
      held.seen(body);
      await held.release;
    }
    const entry = this.script.shift();
    if (entry === undefined) {
      // Over-run: a harmless extra turn so the test sees the call it did not script.
      return {
        status: 200,
        json: answer({ content: "", tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] }),
      };
    }
    if ("http" in entry) {
      const headers: Record<string, string> = {};
      if (entry.retry_after_ms !== undefined) headers["retry-after"] = String(Math.ceil(entry.retry_after_ms / 1000));
      return {
        status: entry.http,
        headers,
        json: { code: entry.code ?? null, retry_after_ms: entry.retry_after_ms ?? null },
      };
    }
    if ("raw" in entry) return { status: 200, json: entry.raw };
    return { status: 200, json: answer(entry) };
  }
}

/** The Workers AI answer shape TL3 reads: `choices[0].message` + `usage`. */
function answer(entry: {
  content?: string;
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: entry.content ?? "",
          tool_calls: (entry.tool_calls ?? []).map((call, i) => ({
            id: `call_fake_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        },
        finish_reason:
          entry.finish_reason ??
          (entry.tool_calls === undefined || entry.tool_calls.length === 0 ? "stop" : "tool_calls"),
      },
    ],
    usage: entry.usage ?? { prompt_tokens: 1000, completion_tokens: 60 },
  };
}

// ---------------------------------------------------------------------------
// The fake Trunk for DO-level tests — the same surface as the scripted lane's:
// /tool, /sync, /stop, /register, with per-attempt TA2 storage, heads-up
// injection through queued ToolResponse fields and /internal/state control.

import type { AttemptState } from "../../../../src/protocol/attempt.ts";
import type { HeadsUp } from "../../../../src/protocol/headsup.ts";
import type { ToolRequest, ToolResponse } from "../../../../src/protocol/tools.ts";

export function attemptBlock(state: AttemptState = "working") {
  return { state, go_arounds: 0, pull_backs: 0 };
}

export class FakeTrunk {
  #server: Server | null = null;
  url = "";
  requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  served: Array<{ path: string; body: Record<string, unknown> }> = [];
  #stored = new Map<string, ToolResponse>();
  #inflight = new Map<string, Promise<ToolResponse>>();
  #maxN = new Map<string, number>();
  /** Fields merged into the next ToolResponses in order (heads_ups, state). */
  queue: Array<Partial<ToolResponse>> = [];
  stopped: { reason: string } | null = null;
  state: AttemptState = "working";
  syncHeadsUps: HeadsUp[] = [];

  /** EV6: answered on `GET /internal/state` — the Agent learns the flag from
   * Trunk's own answer, the way it does against the real object. */
  summaryOnly = false;

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      if (req.method === "GET") {
        if (req.url === "/internal/state") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              pool: "test",
              meta: { summary_only: this.summaryOnly ? "1" : "0" },
              events_out: [],
              timers: [],
              outbox: null,
              served: {},
            }),
          );
        } else {
          res.writeHead(404).end();
        }
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        void this.#handle(req.url ?? "", JSON.parse(body) as Record<string, unknown>).then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.json));
        });
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  async #handle(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    this.requests.push({ path, body });
    if (path === "/tool") {
      const req = body as unknown as ToolRequest;
      const pending = this.#inflight.get(req.call_id);
      if (pending !== undefined) return { status: 200, json: await pending };
      const stored = this.#stored.get(req.call_id);
      if (stored !== undefined) return { status: 200, json: stored };
      const n = Number(req.call_id.split(":").at(-1));
      const maxN = this.#maxN.get(req.attempt_id) ?? 0;
      if (Number.isInteger(n) && n <= maxN && !String(req.call_id).includes(":m")) {
        return {
          status: 200,
          json: {
            call_id: req.call_id,
            ok: false,
            head_seq: 0,
            error: { code: "invalid_args", message: "call_id is not the latest" },
            premises: [],
            heads_ups: [],
            heads_ups_more: false,
            attempt: attemptBlock(this.state),
          },
        };
      }
      const promise = this.#execute(req);
      this.#inflight.set(req.call_id, promise);
      const json = await promise;
      this.#inflight.delete(req.call_id);
      this.served.push({ path, body });
      return { status: 200, json };
    }
    if (path === "/sync") {
      const heads_ups = this.syncHeadsUps;
      this.syncHeadsUps = [];
      return {
        status: 200,
        json: { heads_ups, heads_ups_more: false, head_seq: 0, attempt: attemptBlock(this.state) },
      };
    }
    if (path === "/stop") {
      this.stopped = { reason: String(body.reason ?? "") };
      this.state = "stopped";
      return { status: 200, json: { ok: true, stop_reason: body.reason, attempt: attemptBlock("stopped") } };
    }
    if (path === "/register") {
      return { status: 200, json: { ok: true, heads_ups: [], attempt: attemptBlock(this.state) } };
    }
    return { status: 404, json: { error: { code: "not_found" } } };
  }

  async #execute(req: ToolRequest): Promise<ToolResponse> {
    const state = req.tool === "submit" ? "validated" : this.state;
    // The attempt's state persists: a later /sync must answer the same state
    // the tool response just carried, or the Agent's mirror falls back to
    // `working` and the loop restarts under it (TL11).
    this.state = state;
    const args = req.args as { path?: string; content?: string };
    let result: object;
    switch (req.tool) {
      case "list":
        result = { path: args.path, entries: [{ name: "fish.js", type: "file", bytes: 100 }], truncated: false };
        break;
      case "read":
        result = { path: args.path, oid: "0".repeat(40), content: "// fake guide", edited_by_you: false };
        break;
      case "write":
        result = {
          path: args.path,
          op_seq: 1,
          created: true,
          bytes: String(args.content ?? "").length,
          added: [],
          altered: [],
          removed: [],
          relied_on_by: {},
        };
        break;
      case "submit":
        result = { status: "validated", submit_id: "s_fake", tier: "auto", checks: [] };
        break;
      default:
        result = {};
    }
    const extra = this.queue.shift() ?? {};
    const resp: ToolResponse = {
      call_id: req.call_id,
      ok: extra.ok ?? true,
      head_seq: 0,
      ...(extra.ok === false ? { error: extra.error } : { result }),
      premises: [],
      heads_ups: extra.heads_ups ?? [],
      heads_ups_more: extra.heads_ups_more ?? false,
      attempt: extra.attempt ?? attemptBlock(state),
      ...({} as Record<string, never>),
    };
    this.#stored.set(req.call_id, resp);
    const n = Number(req.call_id.split(":").at(-1));
    this.#maxN.set(req.attempt_id, Math.max(this.#maxN.get(req.attempt_id) ?? 0, Number.isNaN(n) ? 0 : n));
    return resp;
  }
}

/** The `waitFor` of the other workerd harnesses. */
export async function waitFor(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// The landing deployment (04-build-plan 2.5 item 1): the real Worker bundle,
// the real bare-git remote behind `git http-backend`, and the fake Artifacts
// worker — the same three pieces as the Slice-1 landing harness, with the
// fake model behind the `AI` service binding the way a deployment binds the
// real one (fake-ai.mjs offers `run`).

import { mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, gitBytes, startGitServer } from "../../../git/helpers.ts";

const FAKE_ARTIFACTS = join(REPO_ROOT, "test/workerd/landing/fake-artifacts.mjs");

/** A named, receive-pack-enabled scratch repository under `projectRoot`. */
export function createNamedRepo(projectRoot: string, name: string): string {
  const directory = join(projectRoot, name);
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  git(directory, ["config", "http.receivepack", "true"]);
  git(directory, ["config", "receive.denyCurrentBranch", "ignore"]);
  return directory;
}

/** The read sidecar: `git show`, `cat-file`, `ls-tree` over HTTP — the fake
 * binding's `readFile`/`readCommit`/`readTree` data path. */
async function startReadServer(projectRoot: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [, kind, name, ...rest] = url.pathname.split("/");
    const directory = join(projectRoot, name ?? "");
    const ok = existsSync(join(directory, ".git"));
    try {
      if (kind === "exists") {
        response.writeHead(ok ? 200 : 404).end();
      } else if (!ok) {
        response.writeHead(404).end();
      } else if (kind === "file") {
        const [ref, ...path] = rest;
        const bytes = gitBytes(directory, ["show", `${ref}:${path.join("/")}`]);
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(new Uint8Array(bytes));
      } else if (kind === "commit") {
        const type = git(directory, ["cat-file", "-t", rest[0] ?? ""]);
        if (type !== "commit") throw new Error("not a commit");
        const tree = git(directory, ["rev-parse", `${rest[0]}^{tree}`]);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ treeHash: tree }));
      } else if (kind === "tree") {
        const lines = git(directory, ["ls-tree", rest[0] ?? ""]);
        const entries = lines
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [meta, entryName] = line.split("\t");
            const [, type, hash] = (meta ?? "").split(" ");
            return { name: entryName, type, hash };
          });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(entries));
      } else {
        response.writeHead(404).end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
      else response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export type LandingRealWorker = RealWorker & {
  events(pool: string): Promise<Array<Record<string, unknown>>>;
  eventTypes(pool: string): Promise<string[]>;
  repoDir(repo: string): string;
};

export async function startRealLandingWorker(options: {
  ownerKey: string;
  modelUrl: string;
  spendCapUsd?: string;
  repos: string[];
}): Promise<LandingRealWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  const projectRoot = mkdtempSync(join(tmpdir(), "premise-real-repos-"));
  const directories = new Map(options.repos.map((name) => [name, createNamedRepo(projectRoot, name)]));
  const gitServer = await startGitServer(projectRoot, {});
  const readServer = await startReadServer(projectRoot);

  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            OWNER_KEY: options.ownerKey,
            SPEND_CAP_USD: options.spendCapUsd ?? "30",
          },
          serviceBindings: {
            AI: { name: "fake-ai", entrypoint: "AiBinding" },
            POOLS: { name: "fake-artifacts" },
          },
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
          ),
          assets: {
            directory: CLIENT,
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        {
          name: "fake-artifacts",
          modules: [{ type: "ESModule", path: FAKE_ARTIFACTS }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { GIT_ORIGIN: gitServer.origin, READ_ORIGIN: readServer.origin },
        },
        {
          name: "fake-ai",
          modules: [{ type: "ESModule", path: FAKE_AI }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { MODEL_UPSTREAM: options.modelUrl },
        },
      ] as never,
    }),
  );
  await miniflare.ready;

  const namespaces = new Map<DurableObjectBinding, { idFromName(name: string): unknown; get(id: unknown): Stub }>();
  async function namespace(binding: DurableObjectBinding) {
    if (!namespaces.has(binding)) {
      namespaces.set(
        binding,
        (await miniflare.getDurableObjectNamespace(binding)) as unknown as {
          idFromName(name: string): unknown;
          get(id: unknown): Stub;
        },
      );
    }
    return namespaces.get(binding) as { idFromName(name: string): unknown; get(id: unknown): Stub };
  }
  function object(binding: DurableObjectBinding, name: string): ObjectHandle {
    return {
      fetch: async (path, init) =>
        (await namespace(binding)).get((await namespace(binding)).idFromName(name)).fetch(`${ORIGIN}${path}`, init),
    };
  }
  async function events(pool: string): Promise<Array<Record<string, unknown>>> {
    const response = await object("FLOOR", pool).fetch(`/api/pools/${pool}/replay.ndjson`);
    const text = await response.text();
    return text
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    gate: () => object("GATE", "premise"),
    events,
    eventTypes: async (pool) => (await events(pool)).map((event) => String(event.type)),
    repoDir: (repo) => directories.get(repo) ?? "",
    dispose: async () => {
      await miniflare.dispose();
      await gitServer.close();
      await readServer.close();
    },
  };
}
