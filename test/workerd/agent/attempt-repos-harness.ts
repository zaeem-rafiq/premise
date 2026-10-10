// Workerd acceptance for S3: the shipped Worker and Durable Objects, fake model
// and Artifacts bindings, and real git receive-pack. ATTEMPTS and POOLS have
// distinct namespaces, remotes and accepted credentials (SE22, S3b).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createScratchRepo, git, gitBytes, startGitServer, type ScratchRepo } from "../../git/helpers.ts";
import { withFeatures } from "../../support/features.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { DURABLE_OBJECTS, type DurableObjectBinding } from "../../support/workerd.ts";
import type { ObjectHandle } from "./real/harness.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const FAKE_ARTIFACTS = join(REPO_ROOT, "test/workerd/agent/attempt-repos-fake.mjs");
const FAKE_AI = join(REPO_ROOT, "test/workerd/agent/real/fake-ai.mjs");
const ORIGIN = "http://premise.test";
export const RETURNED_TOKEN = "art_v1_deaddeaddeaddeaddeaddeaddeaddead";

process.env.no_proxy = "*";
process.env.NO_PROXY = "*";

type Namespace = "pools" | "attempts";
type RpcCall = {
  namespace: Namespace;
  repo: string;
  method: string;
  args: Record<string, unknown>;
};
export type ProvisionCall = RpcCall & { started_at: number; completed_at: number | null };
export type MintCall = { namespace: Namespace; repo: string; scope: unknown; ttl: unknown };
export type AttemptWorker = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  events(pool: string): Promise<Array<Record<string, unknown>>>;
  repoDir(namespace: Namespace, repo: string): string;
  provisionCalls: ProvisionCall[];
  mintCalls: MintCall[];
  readonly inFlight: number;
  readonly maxInFlight: number;
  readonly pushesInFlight: number;
  readonly maxConcurrentPushesPerAttempt: number;
  holdPushes(): void;
  releasePushes(): void;
  holdProvisioning(): void;
  releaseProvisioning(): void;
  failProvisioning(): void;
  gitRequests(): Array<{ path: string; authorization: string | null; method: string }>;
  dispose(): Promise<void>;
};

/** The namespace stand-in records provisioning before its controllable barrier,
 * so a held call proves the Worker can still submit and land concurrently. */
export async function startAttemptWorker(options: {
  ownerKey: string;
  modelUrl: string;
  enabled: boolean;
}): Promise<AttemptWorker> {
  const projectRoot = mkdtempSync(join(tmpdir(), "premise-attempt-namespaces-"));
  const repos = new Map<string, ScratchRepo>();
  const provisionCalls: ProvisionCall[] = [];
  const mintCalls: MintCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failProvisioning = false;
  let provisionBarrier: Promise<void> | null = null;
  let releaseProvisioning: (() => void) | null = null;
  let pushBarrier: Promise<void> | null = null;
  let releasePushes: (() => void) | null = null;
  let pushesInFlight = 0;
  let maxConcurrentPushesPerAttempt = 0;
  const activePushes = new Map<string, number>();
  let artifactsUrl = "";
  const keyFor = (namespace: Namespace, repo: string) => `${namespace}--${repo}`;
  const repoFor = (namespace: Namespace, name: string): ScratchRepo => {
    const key = keyFor(namespace, name);
    let repo = repos.get(key);
    if (repo === undefined) {
      repo = createScratchRepo("premise-attempt-git-");
      repo.git("config", "http.receivepack", "true");
      repo.git("config", "receive.denyCurrentBranch", "ignore");
      symlinkSync(repo.directory, join(projectRoot, key), "dir");
      repos.set(key, repo);
    }
    return repo;
  };
  const gitServer = await startGitServer(projectRoot);
  gitServer.fault = (request) => {
    const name = decodeURIComponent(new URL(request.path, ORIGIN).pathname.split("/")[1] ?? "");
    return request.authorization === `Bearer minted-${name}-write`
      ? { action: "forward" }
      : { action: "answer", status: 403 };
  };
  const sendJson = (response: ServerResponse, body: unknown) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  async function serve(call: RpcCall, response: ServerResponse): Promise<void> {
    const { namespace, repo: name, method, args } = call;
    const key = keyFor(namespace, name);
    if (method === "create" || method === "fork") {
      if (namespace === "attempts") {
        const recorded: ProvisionCall = { ...call, started_at: Date.now(), completed_at: null };
        provisionCalls.push(recorded);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (provisionBarrier !== null) await provisionBarrier;
          if (failProvisioning) {
            response.writeHead(503).end();
            return;
          }
          repoFor(namespace, name);
        } finally {
          inFlight -= 1;
          recorded.completed_at = Date.now();
        }
      } else {
        repoFor(namespace, name);
      }
      sendJson(response, {
        name,
        remote: `https://attempt-artifacts.test/${key}`,
        defaultBranch: "main",
        token: { plaintext: RETURNED_TOKEN },
      });
      return;
    }
    const repo = repos.get(key);
    if (repo === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (method === "info") {
      sendJson(response, { name, remote: `https://attempt-artifacts.test/${key}`, defaultBranch: "main" });
    } else if (method === "createToken") {
      mintCalls.push({ namespace, repo: name, scope: args.scope, ttl: args.ttl });
      sendJson(response, {
        plaintext: `minted-${key}-${String(args.scope)}`,
        expiresAt: new Date(Date.now() + Number(args.ttl) * 1000).toISOString(),
      });
    } else if (method === "readFile" || method === "readBlob") {
      const bytes = gitBytes(
        repo.directory,
        method === "readFile"
          ? ["show", `${String(args.ref)}:${String(args.path)}`]
          : ["cat-file", "blob", String(args.hash)],
      );
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
    } else if (method === "readCommit") {
      sendJson(response, {
        treeHash: git(repo.directory, ["rev-parse", `${String(args.hash)}^{tree}`]),
        message: git(repo.directory, ["show", "-s", "--format=%B", String(args.hash)]),
      });
    } else if (method === "readTree") {
      const entries = git(repo.directory, ["ls-tree", String(args.hash)])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t");
          const [mode, type, hash] = (meta ?? "").split(" ");
          return { name, mode, type, hash };
        });
      sendJson(response, entries);
    } else {
      response.writeHead(404).end();
    }
  }
  async function proxyGit(request: IncomingMessage, response: ServerResponse, body: Buffer): Promise<void> {
    const path = (request.url ?? "").slice("/git".length);
    const key = new URL(path, ORIGIN).pathname.split("/")[1] ?? "";
    const checkpoint = key.startsWith("attempts--") && request.method === "POST";
    if (checkpoint) {
      pushesInFlight += 1;
      const active = (activePushes.get(key) ?? 0) + 1;
      activePushes.set(key, active);
      maxConcurrentPushesPerAttempt = Math.max(maxConcurrentPushesPerAttempt, active);
    }
    try {
      if (checkpoint && pushBarrier !== null) await pushBarrier;
      const remote = await fetch(`${gitServer.origin}${path}`, {
        method: request.method,
        headers: {
          authorization: request.headers.authorization ?? "",
          "content-type": request.headers["content-type"] ?? "application/octet-stream",
        },
        ...(request.method === "POST" ? { body: new Uint8Array(body) } : {}),
      });
      response
        .writeHead(remote.status, {
          "content-type": remote.headers.get("content-type") ?? "application/octet-stream",
        })
        .end(new Uint8Array(await remote.arrayBuffer()));
    } finally {
      if (checkpoint) {
        pushesInFlight -= 1;
        activePushes.set(key, (activePushes.get(key) ?? 1) - 1);
      }
    }
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const operation = (request.url ?? "").startsWith("/git/")
        ? proxyGit(request, response, body)
        : serve(JSON.parse(body.toString("utf8")) as RpcCall, response);
      void operation.catch(() => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  artifactsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "premise",
          modules: [
            {
              type: "ESModule",
              path: BUNDLE,
              contents: withFeatures(readFileSync(BUNDLE, "utf8"), {
                attempt_repos: options.enabled,
                race: false,
              }),
            },
          ],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { OWNER_KEY: options.ownerKey, SPEND_CAP_USD: "30" },
          outboundService: { name: "fake-git-proxy", entrypoint: "GitProxy" },
          serviceBindings: {
            AI: { name: "fake-ai", entrypoint: "AiBinding" },
            POOLS: { name: "fake-pools" },
            ATTEMPTS: { name: "fake-attempts" },
          },
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
          ),
          assets: {
            directory: join(REPO_ROOT, "dist/client"),
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        {
          name: "fake-git-proxy",
          modules: [{ type: "ESModule", path: FAKE_ARTIFACTS }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { ARTIFACTS_UPSTREAM: artifactsUrl },
        },
        ...(["pools", "attempts"] as const).map((namespace) => ({
          name: `fake-${namespace}`,
          modules: [{ type: "ESModule", path: FAKE_ARTIFACTS }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { ARTIFACTS_UPSTREAM: artifactsUrl, NAMESPACE: namespace },
        })),
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
  type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };
  type NamespaceHandle = { idFromName(name: string): unknown; get(id: unknown): Stub };
  const namespaces = new Map<DurableObjectBinding, NamespaceHandle>();
  function object(binding: DurableObjectBinding, name: string): ObjectHandle {
    return {
      fetch: async (path, init) => {
        let namespace = namespaces.get(binding);
        if (namespace === undefined) {
          namespace = (await miniflare.getDurableObjectNamespace(binding)) as unknown as NamespaceHandle;
          namespaces.set(binding, namespace);
        }
        return namespace.get(namespace.idFromName(name)).fetch(`${ORIGIN}${path}`, init);
      },
    };
  }
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    events: async (pool) => {
      const response = await object("FLOOR", pool).fetch(`/api/pools/${pool}/replay.ndjson`);
      return (await response.text())
        .trim()
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    repoDir: (namespace, name) => repos.get(keyFor(namespace, name))?.directory ?? "",
    provisionCalls,
    mintCalls,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get pushesInFlight() {
      return pushesInFlight;
    },
    get maxConcurrentPushesPerAttempt() {
      return maxConcurrentPushesPerAttempt;
    },
    holdPushes: () => {
      if (pushBarrier === null)
        pushBarrier = new Promise((resolve) => {
          releasePushes = resolve;
        });
    },
    releasePushes: () => {
      releasePushes?.();
      releasePushes = null;
      pushBarrier = null;
    },
    holdProvisioning: () => {
      if (provisionBarrier === null)
        provisionBarrier = new Promise((resolve) => {
          releaseProvisioning = resolve;
        });
    },
    releaseProvisioning: () => {
      releaseProvisioning?.();
      releaseProvisioning = null;
      provisionBarrier = null;
    },
    failProvisioning: () => {
      failProvisioning = true;
    },
    gitRequests: () => gitServer.requests,
    dispose: async () => {
      releaseProvisioning?.();
      releasePushes?.();
      await miniflare.dispose();
      await gitServer.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const repo of repos.values()) repo.remove();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}
