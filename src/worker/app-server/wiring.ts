// The pool lane's wiring module for the routes seam (04-build-plan 3.2). Registers the six
// app-server routes of `protocol/routes.ts`' `APP_ROUTES` plus the `/pool/{rest}` catch-all that
// carries nested repo paths. The lane edits this file, never `../index.ts`.

import type { RouteInput, RouteTable } from "../index.ts";
import type { Env } from "../env.ts";
import type { FloorRead } from "../../protocol/internal.ts";
import { artifactsPoolSource } from "../adapters/pool-source/artifacts.ts";
import { createApp, type AppInput } from "./app.ts";
import { HOST_BUILD, HOST_SOURCE } from "./host-bundle.ts";
import { RateLimiter } from "./respond.ts";

/** The pool's Floor state (FS2): the DO's `/internal/state` endpoint. A non-200 or a transport
 * failure throws; the app maps it to 503 (AS4). `pool.app` is merged in from the stream itself:
 * the Floor's `/internal/state` projection predates IR8, so the last `pool.state` line of
 * `replay.ndjson` carries it (`"tidepool"` — or `null`, the no-app mark of an imported pool). */
async function floorState(env: Env, pool: string): Promise<FloorRead> {
  const stub = env.FLOOR.get(env.FLOOR.idFromName(pool));
  const response = await stub.fetch("https://floor.internal/internal/state");
  if (!response.ok) throw new Error(`floor state: ${response.status}`);
  const read = (await response.json()) as FloorRead;
  if (read.pool.app !== undefined) return read;
  let app: "tidepool" | null = "tidepool";
  const replay = await stub.fetch(`https://floor.internal/api/pools/${pool}/replay.ndjson`);
  if (replay.ok) {
    for (const line of (await replay.text()).split("\n")) {
      try {
        const ev = JSON.parse(line) as { type?: string; app?: "tidepool" | null };
        if (ev.type === "pool.state" && ev.app !== undefined) app = ev.app;
      } catch {
        /* header and partial lines are skipped */
      }
    }
  }
  return { ...read, pool: { ...read.pool, app } };
}

export function wire(table: RouteTable): void {
  const limiter = new RateLimiter(); // fixed windows, in-module state (SE21)
  const handle = (route: AppInput["route"]) => (input: RouteInput) => {
    const env = input.env;
    const state = (pool: string) => floorState(env, pool);
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    return createApp({
      floorState: state,
      pools: artifactsPoolSource({ pools: env.POOLS, floorState: state }),
      host: HOST_SOURCE.length === 0 ? null : { build: HOST_BUILD, source: HOST_SOURCE },
      now: () => Date.now(),
      cache,
      limiter,
    }).handle({ request: input.request, params: input.params, route });
  };

  table.handlers.set("GET /pool/{pool}/{source}/", handle("page"));
  table.handlers.set("GET /pool/{pool}/{source}/~head.js", handle("head"));
  table.handlers.set("GET /pool/{pool}/{source}/~boot.js", handle("boot"));
  table.handlers.set("GET /pool/{pool}/v/{version}/{path}", handle("file"));
  table.handlers.set("GET /pool/{pool}/v/{version}/~registry.js", handle("registry"));
  table.handlers.set("GET /pool/~host.{build}.js", handle("host"));
  table.handlers.set("GET /pool/{rest}", handle("rest"));
}
