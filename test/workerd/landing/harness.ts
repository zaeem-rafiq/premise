// The landing acceptance's workerd harness (04-build-plan 2.2): the trunk harness's Miniflare
// deployment plus the local stand-ins for Artifacts — a real `git http-backend` server (the
// remote Trunk pushes to and `git fsck` runs against) and a read sidecar for the fake POOLS
// binding's `readFile`/`readCommit`/`readTree` (the app server's only data path, AS16).

import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../../support/source.ts";
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

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");
const FAKE_ARTIFACTS = join(REPO_ROOT, "test/workerd/landing/fake-artifacts.mjs");
const ORIGIN = "http://premise.test";

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };

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
  /** A remote's refs as stock git sees them (`refs/heads/main`, `refs/notes/premise`). */
  refs(repo: string): { main: string | null; notes: string | null };
  /** `POST /internal/alarm` on the pool's Trunk — `nowMs` makes the due-check read a later time,
   * so a test drives the retry schedule without sleeping for the real backoff (LP5a). */
  runAlarm(pool: string, nowMs?: number): Promise<Response>;
  /** The `premise-swarm` workflow instance's status, when `swarm: true` was passed. */
  swarmInstanceStatus(id: string): Promise<string>;
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
  repos: string[];
  /** Repos whose every receive-pack push is refused: a real `pre-receive` hook that exits 1. */
  refuseRepos?: string[];
  expectedToken?: string;
  /** Bind `env.SWARM` to the bundle's `SwarmWorkflow` through the local workflows engine. */
  swarm?: boolean;
}): Promise<LandingWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
  const projectRoot = mkdtempSync(join(tmpdir(), "premise-landing-repos-"));
  const directories = new Map(options.repos.map((name) => [name, createNamedRepo(projectRoot, name)]));
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

  const workerOptions = convertV4MiniflareOptions({
    cf: false,
    telemetry: { enabled: false },
    // The Durable Objects' SQLite under the test root — a `restart()` then starts a new
    // Worker over the same storage, which is what LP7 reconciles on (C20-C22).
    resourcePersistencePath: join(projectRoot, "persist"),
    workers: [
      {
        name: "premise",
        modules: [{ type: "ESModule", path: BUNDLE }],
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: options.ownerKey === undefined ? {} : { OWNER_KEY: options.ownerKey },
        durableObjects: Object.fromEntries(
          Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
        ),
        ...(options.swarm === true
          ? {
              workflows: { SWARM: { name: "premise-swarm", className: "SwarmWorkflow" } },
              workflowExports: { SwarmWorkflow: { name: "premise-swarm" } },
            }
          : {}),
        serviceBindings: { POOLS: { name: "fake-artifacts" } },
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
    ],
  });
  let miniflare = new Miniflare(workerOptions);
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
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    trunk: (pool) => object("TRUNK", pool),
    floor: (pool) => object("FLOOR", pool),
    events,
    eventTypes: async (pool) => (await events(pool)).map((event) => String(event.type)),
    repoDir: (repo) => directories.get(repo) ?? "",
    gitRequests: () => gitServer.requests,
    setGitFault: (fault) => {
      gitServer.fault = fault ?? (() => ({ action: "forward" }));
    },
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
    restart: async () => {
      await miniflare.dispose();
      namespaces = new Map();
      miniflare = new Miniflare(workerOptions);
      await miniflare.ready;
    },
    dispose: async () => {
      await miniflare.dispose();
      await gitServer.close();
      await readServer.close();
    },
  };
}
