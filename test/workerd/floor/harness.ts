// The Floor Durable Object harness for workerd tests (Track 1E): the same local deployment as
// test/support/workerd.ts, plus what the stream lane's tests need — POST bodies on the object's
// internal routes and a client WebSocket on the stream route.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { REPO_ROOT } from "../../support/source.ts";
import { DURABLE_OBJECTS } from "../../support/workerd.ts";
import { workerModules } from "../../support/bundle.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const CLIENT = join(REPO_ROOT, "dist/client");
const ORIGIN = "http://premise.test";

/** Miniflare types a stub's fetch through @cloudflare/workers-types, which is not a dependency. */
type Stub = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

export type FloorHandle = {
  /** A request on the Floor Durable Object of `pool` (any method, headers and body). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Opens the stream socket: returns the client end of the 101 upgrade. */
  stream(): Promise<WebSocket>;
  /** JSON body of `/internal/state`. */
  state(): Promise<Record<string, unknown>>;
  /** `/internal/marker`: the in-memory token an eviction replaces. */
  marker(): Promise<string>;
  /** `/internal/evict`: aborts the object inside workerd (the hibernated sockets survive). */
  evict(): Promise<void>;
  dispose(): Promise<void>;
};

/** Posts one source batch to `/internal/events` (EV2: `{source, epoch, events: [{source_n, event}]}`). */
export function appendBody(
  source: string,
  epoch: number,
  events: Array<{ source_n: number; event: Record<string, unknown> }>,
): string {
  return JSON.stringify({ source, epoch, events });
}

/** A minimal `pool.state` event body for the pool `tidepool` (a source event: no `n`, no `t`). */
export function poolState(ts: number): Record<string, unknown> {
  return {
    ts,
    pool: "tidepool",
    src: "trunk",
    type: "pool.state",
    head_seq: 0,
    head_commit: "seed",
    green_seq: 0,
    landed_seq: 0,
    landed_commit: "seed",
    state: "ready",
    reason: null,
    epoch: 1,
    remote: "r",
    plain_remote: null,
    rebuild: null,
    unwitnessed: [],
    real_agents: 1,
    max_real_agents: 6,
    synthetic: false,
    summary_only: false,
  };
}

export async function startFloor(pool = "tidepool"): Promise<FloorHandle> {
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
          ...workerModules(),
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: Object.fromEntries(
            Object.entries(DURABLE_OBJECTS).map(([binding, className]) => [binding, { className, useSQLite: true }]),
          ),
          assets: { directory: CLIENT, binding: "ASSETS" },
        },
      ],
    }),
  );
  await miniflare.ready;

  const namespace = (await miniflare.getDurableObjectNamespace("FLOOR")) as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): Stub;
  };
  let stub = namespace.get(namespace.idFromName(pool));
  /** One stub fetch, re-resolved once: the abort reason surfaces on the first call after an evict. */
  async function call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await stub.fetch(`${ORIGIN}${path}`, init);
    } catch {
      stub = namespace.get(namespace.idFromName(pool));
      return stub.fetch(`${ORIGIN}${path}`, init);
    }
  }

  return {
    fetch: call,
    async stream() {
      const response = await call(`/api/pools/${pool}/stream`, { headers: { upgrade: "websocket" } });
      // `webSocket` is the Workerd extension of `Response`; the test program's DOM type lacks it.
      const socket = (response as Response & { webSocket: WebSocket | null }).webSocket;
      if (response.status !== 101 || socket === null) {
        throw new Error(`stream upgrade failed: ${response.status} ${await response.text()}`);
      }
      // Workerd's socket needs `accept()` — the DOM type of the test program does not name it.
      (socket as unknown as { accept(): void }).accept();
      return socket;
    },
    async state() {
      const response = await call("/internal/state");
      return (await response.json()) as Record<string, unknown>;
    },
    async marker() {
      const response = await call("/internal/marker");
      const body = (await response.json()) as { marker: string };
      return body.marker;
    },
    async evict() {
      // workerd's real eviction path (the acceptance's marker check then holds); hibernated
      // sockets and their attachments survive it, per EV7.
      await miniflare.unsafeEvictDurableObject("premise", "Floor", { name: pool, webSockets: "hibernate" });
      stub = namespace.get(namespace.idFromName(pool));
    },
    dispose: () => miniflare.dispose(),
  };
}
