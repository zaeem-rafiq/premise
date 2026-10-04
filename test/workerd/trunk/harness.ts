// The Trunk lane's workerd harness (Track 1D): the same local deployment as test/support/workerd.ts,
// plus what the lane's tests need — POST-capable fetches on a Durable Object stub, a Floor stream
// socket for the `pool.state` assertions, and a local fake remote that logs the requests it gets.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

export type TrunkWorker = {
  /** A request to the Worker, as a browser or `curl` would send it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A handle on one Durable Object through its binding. */
  object(binding: DurableObjectBinding, name: string): ObjectHandle;
  /** The pool's Trunk object. */
  trunk(pool: string): ObjectHandle;
  /** The pool's Floor object. */
  floor(pool: string): ObjectHandle;
  /** A client socket on the Floor's `/api/pools/{pool}/stream` route. */
  stream(pool: string): Promise<WebSocket>;
  dispose(): Promise<void>;
};

export async function startTrunkWorker(options?: { ownerKey?: string }): Promise<TrunkWorker> {
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
  return {
    // Miniflare types `dispatchFetch`'s init through a different undici than the test project's.
    fetch: (path, init) => miniflare.dispatchFetch(`${ORIGIN}${path}`, init as never),
    object,
    trunk: (pool) => object("TRUNK", pool),
    floor: (pool) => object("FLOOR", pool),
    async stream(pool) {
      const response = await object("FLOOR", pool).fetch(`/api/pools/${pool}/stream`, {
        headers: { upgrade: "websocket" },
      });
      const socket = (response as Response & { webSocket: WebSocket | null }).webSocket;
      if (response.status !== 101 || socket === null) {
        throw new Error(`stream upgrade failed: ${response.status} ${await response.text()}`);
      }
      (socket as unknown as { accept(): void }).accept();
      return socket;
    },
    dispose: () => miniflare.dispose(),
  };
}

export type RemoteRequest = { path: string; body: Record<string, unknown> };

/**
 * The fake remote of the SY2 acceptance: a local HTTP server that logs every request, runs the
 * test's handler (which can look back into the Durable Object to see what was committed), and
 * answers 200. Nothing here leaves the machine.
 */
export class FakeRemote {
  #server: Server | null = null;
  url = "";
  requests: RemoteRequest[] = [];
  #handler: (request: RemoteRequest) => Promise<{ status?: number; json?: unknown }>;

  constructor(
    handler: (request: RemoteRequest) => Promise<{ status?: number; json?: unknown }> = async () => ({
      json: { ok: true },
    }),
  ) {
    this.#handler = handler;
  }

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        const request: RemoteRequest = {
          path: req.url ?? "",
          body: body === "" ? {} : (JSON.parse(body) as Record<string, unknown>),
        };
        void this.#handler(request)
          .then((answer) => {
            this.requests.push(request);
            res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
            res.end(JSON.stringify(answer.json ?? { ok: true }));
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

export async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
