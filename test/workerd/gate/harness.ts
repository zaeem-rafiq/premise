// The gate lane's workerd harness (plan 2.5 item 9): the same local deployment as
// test/support/workerd.ts plus what the gate's tests need — `SPEND_CAP_USD` bound as the string
// the deployment carries, an optional `resourcePersistencePath` so a second Worker on the same
// directory sees the first one's durable state (the SE12 restart), a handle on the one gate
// object ("premise"), and the pool stream read through the Floor's replay export.

import { existsSync } from "node:fs";
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

export type GateWorkerOptions = {
  /** SE1/SE2: the deployment's owner key. Absent, the mutating routes fail closed with 503. */
  ownerKey?: string;
  /** The deployment's `SPEND_CAP_USD` — bound as a string, the way wrangler binds a var. */
  spendCapUsd?: string;
  /** A directory the object storage persists into (Miniflare's `resourcePersistencePath`): a
   * worker started on the same directory after `dispose()` is the SE12 object restart. */
  storageDir?: string;
};

export type GateWorker = {
  /** A request to the Worker, as a browser or `curl` would send it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A handle on one Durable Object through its binding. */
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  /** The deployment's one model gate (`GATE`/"premise"). */
  gate(): ObjectHandle;
  /** A pool's Floor object. */
  floor(pool: string): ObjectHandle;
  /** The pool's stored events — the `replay.ndjson` lines after the header. */
  events(pool: string): Promise<Array<Record<string, unknown>>>;
  dispose(): Promise<void>;
};

export async function startGateWorker(options?: GateWorkerOptions): Promise<GateWorker> {
  if (!existsSync(BUNDLE) || !existsSync(join(CLIENT, "index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first (`npm run test:workerd` builds the Worker only).");
  }
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      ...(options?.storageDir === undefined ? {} : { resourcePersistencePath: options.storageDir }),
      workers: [
        {
          name: "premise",
          modules: [{ type: "ESModule", path: BUNDLE }],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            ...(options?.ownerKey === undefined ? {} : { OWNER_KEY: options.ownerKey }),
            ...(options?.spendCapUsd === undefined ? {} : { SPEND_CAP_USD: options.spendCapUsd }),
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
    object,
    gate: () => object("GATE", "premise"),
    floor: (pool) => object("FLOOR", pool),
    events,
    dispose: () => miniflare.dispose(),
  };
}

/** `POST /internal/<call>` on the gate object with a JSON body. */
export function gateCall(gate: ObjectHandle, call: string, body: unknown = {}): Promise<Response> {
  return gate.fetch(`/internal/${call}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
