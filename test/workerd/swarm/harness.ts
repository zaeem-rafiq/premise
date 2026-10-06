// The swarm lane's workerd harness (plan 2.9 item 8): the gate harness's local deployment plus
// the `SWARM` Workflow binding the launcher answers to, and an owner key for `POST /api/pools`
// and `POST /api/swarm` (PL1, SWR1). The pool stream is read through the Floor's replay export.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { REPO_ROOT } from "../../support/source.ts";
import { DURABLE_OBJECTS, type DurableObjectBinding } from "../../support/workerd.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");
const ORIGIN = "http://premise.test";

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };

export type ObjectHandle = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON body of `GET /internal/state`. */
  state(): Promise<Record<string, unknown>>;
};

export type SwarmWorkerOptions = {
  /** The deployment's owner key — the bearer the owner routes check (SE1). */
  ownerKey: string;
  /** A directory the object storage persists into: a second Worker on it sees the first's
   * durable state (the restart case of EV2a). */
  storageDir?: string;
};

export type SwarmWorker = {
  /** A request to the Worker, as a browser or `curl` would send it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The same request, owner-authenticated. */
  owner(path: string, body: unknown): Promise<Response>;
  /** A handle on one Durable Object through its binding. */
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  /** A pool's Floor object. */
  floor(pool: string): ObjectHandle;
  /** The pool's stored events — the `replay.ndjson` lines after the header. */
  events(pool: string): Promise<Array<Record<string, unknown>>>;
  /** The `SWARM` workflow binding, for instance status checks. */
  swarm(): Promise<{ status(id: string): Promise<string> }>;
  /** The directory object storage persists into, for a restart test. */
  storageDir: string;
  dispose(): Promise<void>;
};

export async function startSwarmWorker(options: SwarmWorkerOptions): Promise<SwarmWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
  const storageDir = options.storageDir ?? mkdtempSync(join(tmpdir(), "premise-swarm-"));
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: storageDir,
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { OWNER_KEY: options.ownerKey },
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
          ),
          workflows: { SWARM: { name: "premise-swarm", className: "SwarmWorkflow" } },
          workflowExports: { SwarmWorkflow: { name: "premise-swarm" } },
          assets: {
            directory: CLIENT,
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
      ],
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
      state: async () => {
        const response = await object(binding, name).fetch("/internal/state");
        return (await response.json()) as Record<string, unknown>;
      },
    };
  }
  async function events(pool: string): Promise<Array<Record<string, unknown>>> {
    const response = await object("FLOOR", pool).fetch(`/api/pools/${pool}/replay.ndjson`);
    if (response.status === 404) return [];
    const text = await response.text();
    return text
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    owner: (path, body) =>
      miniflare.dispatchFetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.ownerKey}`,
        },
        body: JSON.stringify(body),
      } as never),
    object,
    floor: (pool) => object("FLOOR", pool),
    events,
    swarm: async () => {
      const bindings = (await miniflare.getBindings("premise")) as {
        SWARM?: { get(id: string): Promise<{ status(): Promise<{ status: string }> }> };
      };
      return {
        status: async (id) => {
          const instance = await bindings.SWARM?.get(id);
          if (instance === undefined) throw new Error(`no swarm instance ${id}`);
          return (await instance.status()).status;
        },
      };
    },
    storageDir,
    dispose: () => miniflare.dispose(),
  };
}

/** Polls `probe` until it is true or `ms` passes — the stream and the Workflow run async. */
export async function waitFor(probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor: timed out");
}
