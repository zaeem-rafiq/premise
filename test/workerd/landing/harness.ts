// The landing acceptance's workerd harness (04-build-plan 2.2): the trunk harness's Miniflare
// deployment plus the local stand-ins for Artifacts — a real `git http-backend` server (the
// remote Trunk pushes to and `git fsck` runs against) and a read sidecar for the fake POOLS
// binding's `readFile`/`readCommit`/`readTree` (the app server's only data path, AS16).

import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type DurableObjectStorageHandle } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../../support/source.ts";
import { withFeatures } from "../../support/features.ts";
import type { Features } from "../../../src/protocol/floor-json.ts";
import { DURABLE_OBJECTS, type DurableObjectBinding } from "../../support/workerd.ts";
import {
  git,
  gitBytes,
  refValue,
  startGitServer,
  type GitFault,
  type GitHttpServer,
  type RecordedRequest,
} from "../../git/helpers.ts";
import { workerModules } from "../../support/bundle.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");
const FAKE_ARTIFACTS = join(REPO_ROOT, "test/workerd/landing/fake-artifacts.mjs");
const STUB_AGENT = join(REPO_ROOT, "test/workerd/landing/stub-agent.mjs");
const FAKE_AI = join(REPO_ROOT, "test/workerd/agent/real/fake-ai.mjs");
const TRUNK_DOWN = join(REPO_ROOT, "test/workerd/reads/trunk-down.mjs");
const ORIGIN = "http://premise.test";

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };

export type FloorFaultMode = "pass" | "block" | "hold";
export type FloorFaultState = {
  mode: FloorFaultMode;
  held: boolean;
  epoch: number | null;
  sourceNumbers: number[];
};

// Appended only to an opted-in test's in-memory bundle. The production Floor has no fault
// controls. A hold stores a real batch first, then withholds its confirmation while further
// Trunk batches fail: the test can rebuild Trunk before releasing that old-epoch answer.
const FLOOR_FAULT_CLASS = `
export class FaultFloor extends Floor {
  faultMode = "pass";
  held = false;
  heldEpoch = null;
  heldSourceNumbers = [];

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/floor-fault") {
      if (request.method === "POST") {
        const { mode } = await request.json();
        if (!["pass", "block", "hold"].includes(mode) || this.held) {
          return Response.json({ error: "invalid_fault_mode" }, { status: 409 });
        }
        this.faultMode = mode;
      }
      return Response.json({
        mode: this.faultMode, held: this.held,
        epoch: this.heldEpoch, sourceNumbers: this.heldSourceNumbers,
      });
    }
    if (path === "/__test/floor-release" && request.method === "POST") {
      this.held = false;
      return Response.json({ ok: true });
    }
    if (path !== "/internal/events" || request.method !== "POST") return super.fetch(request);
    const body = await request.clone().json();
    if (body.source !== "trunk" || this.faultMode === "pass") return super.fetch(request);
    if (this.faultMode === "block") {
      return Response.json({ error: { code: "test_delivery_blocked" } }, { status: 503 });
    }
    this.faultMode = "block";
    const response = await super.fetch(request);
    if (!response.ok) {
      this.faultMode = "hold";
      return response;
    }
    this.heldEpoch = body.epoch;
    this.heldSourceNumbers = body.events.map((event) => event.source_n);
    this.held = true;
    // A timer keeps the pending request live in workerd while another request releases it.
    while (this.held) await new Promise((resolve) => setTimeout(resolve, 10));
    return response;
  }
}
`;

export type ObjectHandle = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON body of `GET /internal/state`. */
  state(): Promise<Record<string, unknown>>;
};

export type LandingWorker = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  trunk(pool: string): ObjectHandle;
  floor(pool: string): ObjectHandle;
  /** Direct workerd SQLite access for assertions and fault injection, with no production route. */
  sql(
    binding: DurableObjectBinding,
    pool: string,
    ...args: Parameters<DurableObjectStorageHandle["exec"]>
  ): ReturnType<DurableObjectStorageHandle["exec"]>;
  /** Opt-in Floor fault controls. A hold blocks later Trunk deliveries until set to pass. */
  setFloorFault(pool: string, mode: FloorFaultMode): Promise<void>;
  floorFaultState(pool: string): Promise<FloorFaultState>;
  /** Release only the captured confirmation. Subsequent deliveries remain blocked. */
  releaseFloorResponse(pool: string): Promise<void>;
  /** The Floor's replay export: every reduced event, as `type` list. */
  eventTypes(pool: string): Promise<string[]>;
  /** The Floor's replay export: every reduced event body. */
  events(pool: string): Promise<Array<Record<string, unknown>>>;
  /** The remote repository directory of `repo` (for stock-git assertions). */
  repoDir(repo: string): string;
  /** The git server's request log (the receive-pack calls Trunk made). */
  gitRequests(): RecordedRequest[];
  /** The fault hook of the local git server (LP5 rows): assigned per test. */
  setGitFault(fault: ((request: RecordedRequest & { body?: Buffer }) => GitFault) | null): void;
  /** The read sidecar's fault hook: a test fails `log`/`tree`/`blob` reads to wedge the rebuild
   * job between its committed runs (RB3). Default is forward. */
  setReadFault(fault: ReadFault): void;
  /** Arms the fake binding's next `import` failure: an IR2 code name ("REMOTE_AUTH_REQUIRED",
   * "NOT_FOUND", "MEMORY_LIMIT", "UPSTREAM_UNAVAILABLE", "INVALID_URL", "INVALID_INPUT"), or
   * null to clear. */
  setImportFault(code: string | null): void;
  /** Arms the Artifacts scope check on the stand-in git server (SE5c): a `read` token answers
   * upload-pack (fetch/clone) only; every `git-receive-pack` path takes the `write` token; any
   * other credential — or none — is refused (401 on a read path, 403 on a write path). This is
   * the stand-in's version of the real service's "scope `read` cannot write". Implemented on the
   * fault hook, so it and a `setGitFault` fault do not coexist — a later assignment wins. */
  enforceTokenScopes(tokens: { read: string; write: string }): void;
  /** The remote URL a stock-git client clones `repo` from (`http://127.0.0.1:<port>/<repo>`). */
  remoteFor(repo: string): string;
  /** A remote's refs as stock git sees them (`refs/heads/main`, `refs/notes/premise`). */
  refs(repo: string): { main: string | null; notes: string | null };
  /** `POST /internal/alarm` on the pool's Trunk — `nowMs` makes the due-check read a later time,
   * so a test drives the retry schedule without sleeping for the real backoff (LP5a). */
  runAlarm(pool: string, nowMs?: number): Promise<Response>;
  /** The `premise-swarm` workflow instance's status, when `swarm: true` was passed. */
  swarmInstanceStatus(id: string): Promise<string>;
  /** A client socket on the pool's Floor stream route (`GET /api/pools/{pool}/stream`, 12.2). */
  stream(pool: string): Promise<WebSocket>;
  /** Re-bind the `TRUNK` namespace to a class that answers 503 to every fetch, then restart the
   * Worker on the same storage — Slice 7 item 5's "Trunk unreachable" half (FS2, AS16). The
   * pool's Trunk object stays down for the rest of the deployment; there is no way back. */
  breakTrunk(): Promise<void>;
  /** Dispose the Worker and start it again on the same storage — a Trunk abort, LP7 (C20-C22). */
  restart(): Promise<void>;
  dispose(): Promise<void>;
};

/** A named, receive-pack-enabled scratch repository under `projectRoot` (its base name is the
 * URL path `git http-backend` serves it as — the Artifacts repository name). */
export function createNamedRepo(projectRoot: string, name: string): string {
  const directory = join(projectRoot, name);
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  git(directory, ["config", "http.receivepack", "true"]);
  git(directory, ["config", "receive.denyCurrentBranch", "ignore"]);
  return directory;
}

/** The read sidecar: `git show`, `git cat-file` and `git ls-tree` over HTTP, plus `/exists` for
 * the fake binding's `get`/`create` existence checks. Same repositories as the git server. */
export type ReadFault =
  ((request: { path: string }) => { action: "forward" } | { action: "answer"; status: number }) | null;

/** The code a test arms for the next `import` the fake binding receives (IR2's table): the
 * stand-in reports it as `CODE: detail` because an error's `code` does not cross the service
 * binding — the route maps either shape. */
export type ImportFault = { current: string | null };

async function startReadServer(
  projectRoot: string,
): Promise<{ origin: string; fault: { current: ReadFault }; importFault: ImportFault; close(): Promise<void> }> {
  const fault: { current: ReadFault } = { current: null };
  const importFault: ImportFault = { current: null };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [, kind, name, ...rest] = url.pathname.split("/");
    const directory = join(projectRoot, name ?? "");
    const ok = existsSync(join(directory, ".git"));
    try {
      // The fault hook lets a test fail object reads mid-rebuild — the wedge that proves the
      // durable cursor resumes where the last committed run stopped (3.6, RB3).
      const verdict = fault.current?.({ path: url.pathname });
      if (verdict !== undefined && verdict.action === "answer") {
        response.writeHead(verdict.status).end();
        return;
      }
      if (kind === "import-fault") {
        // The fake binding asks before every `import`: a code armed here becomes its thrown
        // `CODE: name` (the service binding cannot carry a `.code`, so the text carries it).
        const code = importFault.current;
        if (code === null) response.writeHead(204).end();
        else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code }));
        return;
      }
      if (kind === "import") {
        // The stand-in's `import` (IR2): `git clone` a local source repo into the pool's
        // repo name — a worktree clone, since every read path keys on `<name>/.git`.
        // `from`/`name` are the harness's own directory names, never a client string.
        const from = url.searchParams.get("from") ?? "";
        const branch = url.searchParams.get("branch");
        const target = name ?? "";
        if (
          !/^[a-z0-9][a-z0-9-]{0,62}$/.test(target) ||
          !/^[a-z0-9][a-z0-9-]{0,62}$/.test(from) ||
          (branch !== null && !/^[A-Za-z0-9._/-]+$/.test(branch))
        ) {
          response.writeHead(400).end();
          return;
        }
        const sourceDir = join(projectRoot, from);
        if (!existsSync(join(sourceDir, ".git"))) {
          response.writeHead(404).end();
          return;
        }
        if (ok) {
          response.writeHead(409).end(); // ALREADY_EXISTS
          return;
        }
        try {
          git(projectRoot, [
            "clone",
            "--quiet",
            // The sandbox denies reads of git's template directory (the same refusal the
            // git wrapper's `--template=` works around for `init`); a clone copies them too.
            "--template=",
            ...(branch === null ? [] : ["--branch", branch]),
            `file://${sourceDir}`,
            target,
          ]);
          // The pool's repo accepts pushes like every created repo.
          git(join(projectRoot, target), ["config", "http.receivepack", "true"]);
          git(join(projectRoot, target), ["config", "receive.denyCurrentBranch", "ignore"]);
        } catch {
          response.writeHead(502).end();
          return;
        }
        // The clone's checked-out branch is the binding's `defaultBranch` answer — the request's
        // branch when one rode the URL, else the source's default the clone picked (IR10/IR11).
        const resolved = git(join(projectRoot, target), ["symbolic-ref", "--short", "HEAD"]);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ branch: resolved }));
        return;
      }
      if (kind === "branch") {
        // The repository's default branch — `symbolic-ref HEAD` — for the fake binding's `info`.
        const head = git(directory, ["symbolic-ref", "--short", "HEAD"]);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ branch: head }));
        return;
      }
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
        // The platform's `readCommit`/`log` row: %x1f field separators, %B last.
        const raw = gitBytes(directory, [
          "show",
          "-s",
          "--format=%H%x1f%T%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%P%x1f%ct%x1f%B",
          rest[0] ?? "",
        ]);
        const parts = Buffer.from(raw).toString("utf8").split("\x1f");
        const meta = {
          hash: parts[0],
          treeHash: parts[1],
          author: { name: parts[2], email: parts[3] },
          committer: { name: parts[4], email: parts[5] },
          parents: (parts[6] ?? "").trim() === "" ? [] : parts[6]!.trim().split(" "),
          committedAt: Number(parts[7]),
          message: (parts[8] ?? "").replace(/\n$/, ""),
        };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(meta));
      } else if (kind === "blob") {
        const type = git(directory, ["cat-file", "-t", rest[0] ?? ""]);
        if (type !== "blob") throw new Error("not a blob");
        const bytes = gitBytes(directory, ["cat-file", "blob", rest[0] ?? ""]);
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(new Uint8Array(bytes));
      } else if (kind === "log") {
        // First-parent, newest first — the platform's `log` (S7): the rebuild's walk.
        const ref = rest[0] ?? "HEAD";
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        let out;
        try {
          out = gitBytes(directory, [
            "log",
            ref,
            "--first-parent",
            `--max-count=${limit}`,
            `--skip=${offset}`,
            "--format=%H%x1f%T%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%P%x1f%ct%x1f%B%x1e",
          ]);
        } catch {
          out = Buffer.from("");
        }
        const commits = Buffer.from(out)
          .toString("utf8")
          .split("\x1e")
          .filter((r) => r.trim() !== "")
          .map((record) => {
            const parts = record.replace(/^\n/, "").split("\x1f");
            return {
              hash: parts[0],
              treeHash: parts[1],
              author: { name: parts[2], email: parts[3] },
              committer: { name: parts[4], email: parts[5] },
              parents: (parts[6] ?? "").trim() === "" ? [] : parts[6]!.trim().split(" "),
              committedAt: Number(parts[7]),
              message: (parts[8] ?? "").replace(/\n$/, ""),
            };
          });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(commits));
      } else if (kind === "tree") {
        const lines = git(directory, ["ls-tree", rest[0] ?? ""]);
        const entries = lines
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [meta, entryName] = line.split("\t");
            const [mode, type, hash] = (meta ?? "").split(" ");
            return { name: entryName, type, hash, mode };
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
    fault,
    importFault,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * The deployment of the acceptance: the real Worker bundle, its four Durable Objects, and
 * `env.POOLS` service-bound to the fake Artifacts worker (whose `GIT_ORIGIN`/`READ_ORIGIN`
 * point at the two local servers). `gate.expectedToken` — when given — is what the git server
 * requires of every push request, standing in for Artifacts' token check.
 */
// Workerd honours the proxy variables of the environment (`HTTP_PROXY` and friends); the only
// remotes this deployment has are the two loopback servers below, so `no_proxy` must cover them
// or every push/read fetch is handed to a proxy that cannot reach 127.0.0.1.
process.env.no_proxy = "*";
process.env.NO_PROXY = "*";

export async function startLandingWorker(options: {
  ownerKey?: string;
  /** Enable Slice 11 only in this isolated test bundle; production flags are unchanged. */
  held?: boolean;
  /** The flags this test runs with, whatever the build ships (`withFeatures`); `held` above is
   * shorthand for `{ held: true }`. */
  features?: Partial<Features>;
  repos: string[];
  /** Repos whose every receive-pack push is refused: a real `pre-receive` hook that exits 1. */
  refuseRepos?: string[];
  expectedToken?: string;
  /** Bind `env.SWARM` to the bundle's `SwarmWorkflow` through the local workflows engine. */
  swarm?: boolean;
  /** Bind `env.AGENT` to the recording `StubAgent` of stub-agent.mjs instead of the real Agent
   * (2.3 item 9's "a stub Agent bound in place of the real one"): `/resume` calls are logged
   * and answered by the mode the test sets through `/internal/mode`. */
  agentStub?: boolean;
  /** Add a test-only Floor subclass that blocks or delays Trunk delivery confirmations. */
  floorFaults?: boolean;
  /** Local repositories the fake Artifacts `import` clones from (IR1/IR2's stand-in): each name
   * is a repo under the test root the test fills itself — `repoDir(name)` reaches it. The fake
   * maps a source url's last path segment to the same name. */
  importSources?: string[];
  /** The fake model's loopback URL (the real-agent lane's FakeModel): when given, `AI` is bound
   * to the fake-ai worker exactly where a deployment binds Workers AI (06-repos step 1). */
  modelUrl?: string;
  /** The gate's `SPEND_CAP_USD` — bound only when `modelUrl` is: the real agent's model calls
   * go through the gate, and an absent cap fails closed (`spend_cap` on every call). */
  spendCapUsd?: string;
  /** Let `sql()` read the objects' storage (Miniflare's `unsafeInspectDurableObjects`). */
  inspect?: boolean;
  /** Plain variables of the deployment, as wrangler's `vars` (the Clef switches, 01-core TR10). */
  vars?: Record<string, string>;
}): Promise<LandingWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
  const projectRoot = mkdtempSync(join(tmpdir(), "premise-landing-repos-"));
  // A test's own flags ride an in-memory copy of the module (FJ1, `withFeatures`): no file is
  // written, and the build's shipped flags apply only where a test names none.
  const features: Partial<Features> = { ...(options.held === true ? { held: true } : {}), ...options.features };
  let contents = Object.keys(features).length === 0 ? null : withFeatures(readFileSync(BUNDLE, "utf8"), features);
  if (options.floorFaults === true) contents = (contents ?? readFileSync(BUNDLE, "utf8")) + FLOOR_FAULT_CLASS;
  const directories = new Map(
    [...options.repos, ...(options.importSources ?? [])].map((name) => [name, createNamedRepo(projectRoot, name)]),
  );
  // A refusal by real git: the hook declines the request before a command is checked. Hooks live
  // beside `.git` on `core.hooksPath` — this sandbox denies direct writes under any `.git/` path.
  for (const name of options.refuseRepos ?? []) {
    const dir = directories.get(name);
    if (dir === undefined) throw new Error(`refuseRepos names ${name}, which is not in repos`);
    const hooks = join(dir, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-receive"), 0o755);
    // Absolute: a relative hooksPath resolves against the receive-pack cwd, not the worktree.
    git(dir, ["config", "core.hooksPath", hooks]);
  }
  const gitServer: GitHttpServer = await startGitServer(projectRoot, {
    gate: options.expectedToken === undefined ? {} : { expectedToken: options.expectedToken },
  });
  const readServer = await startReadServer(projectRoot);

  // `trunkDown` is what `breakTrunk()` sets: the next Miniflare this build describes binds the
  // `TRUNK` namespace to the 503 stand-in of trunk-down.mjs instead of the real Trunk.
  let trunkDown = false;
  const buildWorkerOptions = () =>
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      ...(options.floorFaults === true || options.inspect === true ? { unsafeInspectDurableObjects: true } : {}),
      // The Durable Objects' SQLite under the test root — a `restart()` then starts a new
      // Worker over the same storage, which is what LP7 reconciles on (C20-C22).
      resourcePersistencePath: join(projectRoot, "persist"),
      workers: [
        {
          name: "premise",
          ...workerModules(contents ?? undefined),
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            ...(options.ownerKey === undefined ? {} : { OWNER_KEY: options.ownerKey }),
            // The gate reads its cap fresh on every call: absent means 0, and every model
            // call is refused `spend_cap` (SE7). Bound where the `AI` binding is bound.
            ...(options.modelUrl === undefined ? {} : { SPEND_CAP_USD: options.spendCapUsd ?? "30" }),
            ...options.vars,
          },
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [
              binding,
              binding === "AGENT" && options.agentStub === true
                ? { className: "StubAgent", scriptName: "stub-agent" }
                : binding === "TRUNK" && trunkDown
                  ? { className: "TrunkDown", scriptName: "trunk-down" }
                  : binding === "FLOOR" && options.floorFaults === true
                    ? { className: "FaultFloor", useSQLite: true }
                    : { className, useSQLite: true },
            ]),
          ),
          ...(options.swarm === true
            ? {
                workflows: { SWARM: { name: "premise-swarm", className: "SwarmWorkflow" } },
                workflowExports: { SwarmWorkflow: { name: "premise-swarm" } },
              }
            : {}),
          serviceBindings: {
            POOLS: { name: "fake-artifacts" },
            ...(options.modelUrl === undefined ? {} : { AI: { name: "fake-ai", entrypoint: "AiBinding" } }),
          },
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
        ...(options.modelUrl === undefined
          ? []
          : [
              {
                name: "fake-ai",
                modules: [{ type: "ESModule" as const, path: FAKE_AI }],
                compatibilityDate: "2026-10-01",
                compatibilityFlags: ["nodejs_compat"],
                bindings: { MODEL_UPSTREAM: options.modelUrl },
              },
            ]),
        ...(options.agentStub === true
          ? [
              {
                name: "stub-agent",
                modules: [{ type: "ESModule" as const, path: STUB_AGENT }],
                compatibilityDate: "2026-10-01",
                compatibilityFlags: ["nodejs_compat"],
                durableObjects: { StubAgent: { className: "StubAgent", useSQLite: true } },
              },
            ]
          : []),
        ...(trunkDown
          ? [
              {
                name: "trunk-down",
                modules: [{ type: "ESModule" as const, path: TRUNK_DOWN }],
                compatibilityDate: "2026-10-01",
                compatibilityFlags: ["nodejs_compat"],
                durableObjects: { TrunkDown: { className: "TrunkDown", useSQLite: true } },
              },
            ]
          : []),
      ],
    });
  let miniflare = new Miniflare(buildWorkerOptions());
  await miniflare.ready;

  let namespaces = new Map<DurableObjectBinding, { idFromName(name: string): unknown; get(id: unknown): Stub }>();
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
      state: async () => {
        const response = await object(binding, name).fetch("/internal/state");
        return (await response.json()) as Record<string, unknown>;
      },
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
  async function floorControl(pool: string, path: string, init?: RequestInit): Promise<Response> {
    if (options.floorFaults !== true) throw new Error("startLandingWorker requires floorFaults for this control");
    const response = await object("FLOOR", pool).fetch(path, init);
    if (!response.ok) throw new Error(`Floor fault control failed: ${response.status} ${await response.text()}`);
    return response;
  }
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    trunk: (pool) => object("TRUNK", pool),
    floor: (pool) => object("FLOOR", pool),
    sql: async (binding, pool, ...args) => {
      const className = binding === "FLOOR" && options.floorFaults === true ? "FaultFloor" : DURABLE_OBJECTS[binding];
      const storage = await miniflare.unsafeGetDurableObjectStorage("premise", className, { name: pool });
      return storage.exec(...args);
    },
    setFloorFault: async (pool, mode) => {
      await floorControl(pool, "/__test/floor-fault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    },
    floorFaultState: async (pool) => {
      const response = await floorControl(pool, "/__test/floor-fault");
      return (await response.json()) as FloorFaultState;
    },
    releaseFloorResponse: async (pool) => {
      await floorControl(pool, "/__test/floor-release", { method: "POST" });
    },
    events,
    eventTypes: async (pool) => (await events(pool)).map((event) => String(event.type)),
    repoDir: (repo) => {
      const known = directories.get(repo);
      if (known !== undefined) return known;
      // The fake's `import` clones into the same root — a clone-made repo answers by name too.
      const dir = join(projectRoot, repo);
      return existsSync(join(dir, ".git")) ? dir : "";
    },
    gitRequests: () => gitServer.requests,
    setGitFault: (fault) => {
      gitServer.fault = fault ?? (() => ({ action: "forward" }));
    },
    setReadFault: (fault) => {
      readServer.fault.current = fault;
    },
    setImportFault: (code) => {
      readServer.importFault.current = code;
    },
    enforceTokenScopes: ({ read, write }) => {
      gitServer.fault = (request) => {
        const bearer = request.authorization;
        if (request.path.includes("git-receive-pack")) {
          // A push — discovery and the pack alike — takes the write token and nothing else.
          return bearer === `Bearer ${write}` ? { action: "forward" } : { action: "answer", status: 403 };
        }
        return bearer === `Bearer ${read}` || bearer === `Bearer ${write}`
          ? { action: "forward" }
          : { action: "answer", status: 401 };
      };
    },
    remoteFor: (repo) => `${gitServer.origin}/${repo}`,
    refs: (repo) => {
      const dir = directories.get(repo);
      if (dir === undefined) throw new Error(`no repo named ${repo}`);
      return { main: refValue(dir, "refs/heads/main"), notes: refValue(dir, "refs/notes/premise") };
    },
    runAlarm: (pool, nowMs) =>
      object("TRUNK", pool).fetch(`/internal/alarm${nowMs === undefined ? "" : `?now=${nowMs}`}`, {
        method: "POST",
      }),
    swarmInstanceStatus: async (id) => {
      const bindings = (await miniflare.getBindings("premise")) as {
        SWARM?: { get(id: string): Promise<{ status(): Promise<{ status: string }> }> };
      };
      const instance = await bindings.SWARM?.get(id);
      if (instance === undefined) throw new Error(`no swarm instance ${id}`);
      return (await instance.status()).status;
    },
    stream: async (pool) => {
      const response = await object("FLOOR", pool).fetch(`/api/pools/${pool}/stream`, {
        headers: { upgrade: "websocket" },
      });
      // `webSocket` is the Workerd extension of `Response`; the test program's DOM type lacks it.
      const socket = (response as Response & { webSocket: WebSocket | null }).webSocket;
      if (response.status !== 101 || socket === null) {
        throw new Error(`stream upgrade failed: ${response.status} ${await response.text()}`);
      }
      // Workerd's socket needs `accept()` — the DOM type of the test program does not name it.
      (socket as unknown as { accept(): void }).accept();
      return socket;
    },
    breakTrunk: async () => {
      trunkDown = true;
      await miniflare.dispose();
      namespaces = new Map();
      miniflare = new Miniflare(buildWorkerOptions());
      await miniflare.ready;
    },
    restart: async () => {
      await miniflare.dispose();
      namespaces = new Map();
      miniflare = new Miniflare(buildWorkerOptions());
      await miniflare.ready;
    },
    dispose: async () => {
      await miniflare.dispose();
      await gitServer.close();
      await readServer.close();
    },
  };
}
