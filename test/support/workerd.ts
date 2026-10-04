// Starts the built Worker bundle in local workerd through the Miniflare API (docs/spec/04-build-plan.md 1.4).
//
// Nothing started here leaves this machine: no request for location data, no telemetry, and no binding to
// Artifacts, Workers AI, the Worker Loader or Workflows. A test that needs one of those adds a local fake.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { REPO_ROOT } from "./source.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");

/** Binding name and class name of the four Durable Objects of wrangler.jsonc. */
export const DURABLE_OBJECTS = { TRUNK: "Trunk", AGENT: "Agent", FLOOR: "Floor", GATE: "ModelGate" } as const;

export type DurableObjectBinding = keyof typeof DURABLE_OBJECTS;

/** What a test reads from a response. */
export type WorkerResponse = {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

// Miniflare types a Durable Object namespace through `@cloudflare/workers-types`, which is not a dependency
// of this project. These are the three members the tests use.
type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: { method: string }): Promise<WorkerResponse> };
};

export type LocalWorker = {
  /** A request to the Worker, as a browser or `curl` would send it. */
  fetch(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<WorkerResponse>;
  /** A request to one Durable Object, as the Worker would send it through its binding. */
  fetchDurableObject(binding: DurableObjectBinding, name: string, path: string): Promise<WorkerResponse>;
  dispose(): Promise<void>;
};

/** What a test configures on the deployment. */
export type WorkerOptions = {
  /** SE1: the deployment's owner key. Absent, the mutating routes fail closed with 503. */
  ownerKey?: string;
};

/** Starts the bundle that `npm run build` wrote. Call `dispose()` when the tests are done. */
export async function startWorker(options?: WorkerOptions): Promise<LocalWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
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
          bindings: options?.ownerKey === undefined ? {} : { OWNER_KEY: options.ownerKey },
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
      ],
    }),
  );
  await miniflare.ready;

  const origin = "http://premise.test";
  return {
    fetch: (path, init) => miniflare.dispatchFetch(`${origin}${path}`, init),
    async fetchDurableObject(binding, name, path) {
      const namespace = (await miniflare.getDurableObjectNamespace(binding)) as unknown as Namespace;
      return namespace.get(namespace.idFromName(name)).fetch(`${origin}${path}`);
    },
    dispose: () => miniflare.dispose(),
  };
}
